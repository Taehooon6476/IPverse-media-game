#include "IpverseGameMode.h"
#include "IpverseCharacter.h"
#include "IpverseEnemy.h"
#include "IpverseEnvironment.h"
#include "IpverseGame.h"
#include "IpverseHud.h"
#include "IpverseLevel.h"
#include "IpverseNpc.h"
#include "IpversePickup.h"
#include "IpversePlayerController.h"
#include "IpverseSpecSubsystem.h"

#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "Kismet/GameplayStatics.h"

AIpverseGameMode::AIpverseGameMode()
{
	PrimaryActorTick.bCanEverTick = true;
	DefaultPawnClass = nullptr; // the player pawn is spawned once the world is built
	PlayerControllerClass = AIpversePlayerController::StaticClass();
	HUDClass = AIpverseHud::StaticClass();
}

void AIpverseGameMode::HandleStartingNewPlayer_Implementation(APlayerController* NewPlayer)
{
	// no default pawn yet: StartGame() spawns and possesses the IP character
	if (NewPlayer && !NewPlayer->GetPawn() && Player)
	{
		NewPlayer->Possess(Player);
	}
}

AIpverseHud* AIpverseGameMode::Hud() const
{
	APlayerController* PC = UGameplayStatics::GetPlayerController(this, 0);
	return PC ? Cast<AIpverseHud>(PC->GetHUD()) : nullptr;
}

void AIpverseGameMode::BeginPlay()
{
	Super::BeginPlay();
	Environment = GetWorld()->SpawnActor<AIpverseEnvironment>();
	Spec = GetGameInstance()->GetSubsystem<UIpverseSpecSubsystem>();
	Environment->Configure(Spec->GetTemplate() == EIpverseTemplate::Arena, Spec->Accent);
	if (Spec->GetState() == EIpverseLoadState::Ready || Spec->GetState() == EIpverseLoadState::Failed)
	{
		HandleLoaded(Spec->GetState() == EIpverseLoadState::Ready);
	}
	else
	{
		Spec->OnLoaded.AddUObject(this, &AIpverseGameMode::HandleLoaded);
		Spec->Load();
	}
}

void AIpverseGameMode::HandleLoaded(bool bSuccess)
{
	if (Phase != EPhase::Loading)
	{
		return;
	}
	if (!bSuccess)
	{
		UE_LOG(LogIpverse, Warning, TEXT("Manifest failed (%s); starting the default arena"), *Spec->GetFailure());
	}
	StartGame();
}

void AIpverseGameMode::StartGame()
{
	bArena = Spec->GetTemplate() == EIpverseTemplate::Arena;
	Rng.Initialize(Spec->Seed);
	Environment->Configure(bArena, Spec->Accent);
	Level = GetWorld()->SpawnActor<AIpverseLevel>();
	if (bArena) { Level->BuildArena(Spec->Seed, Spec->Accent); }
	else { Level->BuildValley(Spec->Seed); }

	DifficultyScale = Spec->Difficulty == TEXT("easy") ? 0.7f : Spec->Difficulty == TEXT("hard") ? 1.45f : 1.f;
	MaxAlive = Spec->Difficulty == TEXT("easy") ? 3 : Spec->Difficulty == TEXT("hard") ? 7 : 5;
	Objective = Spec->ObjectiveType;
	if (bArena && Objective != TEXT("survive")) { Objective = TEXT("kills"); }
	if (!bArena && Objective != TEXT("collect")) { Objective = TEXT("talk"); }
	Target = FMath::Clamp(Spec->ObjectiveTarget, 1, 200);
	if (Objective == TEXT("survive")) { Target = FMath::Clamp(Target, 20, 200); }
	if (Objective == TEXT("collect")) { Target = FMath::Clamp(Target, 1, 12); }
	if (Objective == TEXT("talk")) { Target = FMath::Clamp(Target, 1, 4); }

	// player
	const FVector Start = bArena ? FVector(0.f, -1200.f, 0.f) : FVector(0.f, 0.f, Level->GroundZ(0.f, 0.f));
	FActorSpawnParameters Always;
	Always.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AdjustIfPossibleButAlwaysSpawn;
	Player = GetWorld()->SpawnActor<AIpverseCharacter>(Start + FVector(0, 0, 140.f), FRotator(0.f, bArena ? 90.f : 0.f, 0.f), Always);
	const FIpverseEntity* PlayerEntity = Spec->Player();
	Player->ApplyEntity(PlayerEntity ? *PlayerEntity : FIpverseEntity(), Spec->Accent, bArena);
	if (APlayerController* PC = UGameplayStatics::GetPlayerController(this, 0))
	{
		PC->Possess(Player);
		PC->SetControlRotation(FRotator(-12.f, bArena ? 90.f : 0.f, 0.f));
	}

	// props (each spec prop twice), and collectibles for a collect objective
	const TArray<FIpverseEntity>& All = Spec->Entities;
	for (int32 i = 0; i < All.Num(); ++i)
	{
		if (All[i].Role == TEXT("prop"))
		{
			for (int32 n = 0; n < 2; ++n) { SpawnPickup(i, Level->RandomSpot(Rng, 900.f, Level->PlayRadius())); }
		}
	}
	if (Objective == TEXT("collect"))
	{
		const int32 KeyProp = All.IndexOfByPredicate([](const FIpverseEntity& E) { return E.Role == TEXT("prop") && E.Mesh; });
		for (int32 n = 0; n < Target; ++n)
		{
			SpawnPickup(KeyProp, Level->RandomSpot(Rng, 1500.f, 8000.f));
		}
	}

	// NPCs (valley): the manifest's npc IP first, then robed placeholders; dialogue split between them
	if (!bArena)
	{
		const TArray<FIpverseEntity> NpcEntities = Spec->ByRole(TEXT("npc"));
		const int32 Count = Objective == TEXT("talk") ? Target : 1;
		const TArray<FString>& Lines = Spec->Dialogue;
		for (int32 n = 0; n < Count; ++n)
		{
			const FVector At = n == 0 ? FVector(1800.f, 900.f, Level->GroundZ(1800.f, 900.f)) : Level->RandomSpot(Rng, 2500.f, 7000.f);
			AIpverseNpc* Npc = GetWorld()->SpawnActor<AIpverseNpc>(At, FRotator(0.f, 200.f, 0.f), Always);
			TArray<FString> Mine;
			for (int32 l = n; l < Lines.Num(); l += Count) { Mine.Add(Lines[l]); }
			const FIpverseEntity* E = NpcEntities.IsValidIndex(n) ? &NpcEntities[n] : nullptr;
			const FString Name = E && !E->Name.IsEmpty() ? E->Name : (n == 0 ? TEXT("마을 장로") : FString::Printf(TEXT("여행자 %d"), n));
			Npc->Setup(E, Name, Mine, Spec->Accent);
			Npcs.Add(Npc);
		}
		// roaming enemies from the spec (rpg allows 0-5 types)
		for (int32 i = 0; i < All.Num(); ++i)
		{
			if (All[i].Role != TEXT("enemy")) { continue; }
			for (int32 n = 0; n < 2; ++n)
			{
				const FVector At = Level->RandomSpot(Rng, 3500.f, 8500.f);
				if (AIpverseEnemy* Enemy = GetWorld()->SpawnActor<AIpverseEnemy>(At + FVector(0, 0, 120.f), FRotator::ZeroRotator, Always))
				{
					Enemy->ApplyEntity(All[i], DifficultyScale, 1800.f);
					++Alive;
				}
			}
		}
	}

	Phase = EPhase::Playing;
	Elapsed = 0.f;
	NextSpawn = 2.f;
	UE_LOG(LogIpverse, Log, TEXT("Started %s (%s %d), player mesh %s"), *Spec->Genre, *Objective, Target,
		PlayerEntity && PlayerEntity->Mesh ? TEXT("IP GLB") : TEXT("placeholder"));
}

void AIpverseGameMode::SpawnEnemy(bool bNearPlayerRing)
{
	const TArray<FIpverseEntity> Types = Spec->ByRole(TEXT("enemy"));
	FIpverseEntity Type;
	if (Types.Num() > 0)
	{
		Type = Types[EnemyCursor++ % Types.Num()];
	}
	else
	{
		Type.Role = TEXT("enemy");
		Type.Shape = TEXT("circle");
	}
	FVector At = Level->RandomSpot(Rng, 1500.f, Level->PlayRadius());
	if (bNearPlayerRing && Player && FVector::Dist2D(At, Player->GetActorLocation()) < 1200.f)
	{
		At = Level->RandomSpot(Rng, Level->PlayRadius() * 0.8f, Level->PlayRadius());
	}
	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AdjustIfPossibleButDontSpawnIfColliding;
	if (AIpverseEnemy* Enemy = GetWorld()->SpawnActor<AIpverseEnemy>(At + FVector(0, 0, 110.f), FRotator::ZeroRotator, Params))
	{
		Enemy->ApplyEntity(Type, DifficultyScale, 1e9f);
		++Alive;
	}
}

void AIpverseGameMode::SpawnPickup(int32 EntityIndex, const FVector& At)
{
	FIpverseEntity E;
	if (Spec->Entities.IsValidIndex(EntityIndex))
	{
		E = Spec->Entities[EntityIndex];
	}
	if (Objective == TEXT("collect") && E.Role != TEXT("prop"))
	{
		E.Effect = TEXT("key");
	}
	FActorSpawnParameters Always;
	Always.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	if (AIpversePickup* P = GetWorld()->SpawnActor<AIpversePickup>(At, FRotator::ZeroRotator, Always))
	{
		P->ApplyEntity(E);
	}
}

void AIpverseGameMode::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	if (Phase == EPhase::Playing)
	{
		Elapsed += DeltaSeconds;
		if (bArena && Elapsed >= NextSpawn && Alive < MaxAlive + (Objective == TEXT("survive") ? int32(Elapsed / 30.f) : 0))
		{
			SpawnEnemy(true);
			const float Interval = Objective == TEXT("survive") ? FMath::Max(0.8f, 3.f - Elapsed / 40.f) : 2.4f;
			NextSpawn = Elapsed + Interval / DifficultyScale;
		}
		if (Objective == TEXT("survive"))
		{
			Progress = FMath::Min(Target, int32(Elapsed));
			if (Elapsed >= Target) { Finish(true); }
		}
		// talking: leave the dialogue when walking away
		if (Talking && Player && FVector::Dist2D(Talking->GetActorLocation(), Player->GetActorLocation()) > 600.f)
		{
			Talking = nullptr;
		}
	}
	UpdateHud();
}

void AIpverseGameMode::Interact(AIpverseCharacter* InPlayer)
{
	if (Phase != EPhase::Playing || bArena)
	{
		return;
	}
	AIpverseNpc* Near = nullptr;
	for (AIpverseNpc* Npc : Npcs)
	{
		if (Npc && FVector::Dist2D(Npc->GetActorLocation(), InPlayer->GetActorLocation()) < 450.f) { Near = Npc; break; }
	}
	if (!Near)
	{
		return;
	}
	if (Talking != Near)
	{
		Talking = Near;
		Near->NextLine = 0;
		return;
	}
	if (++Near->NextLine >= Near->Lines.Num())
	{
		Talking = nullptr;
		if (!Near->bTalked)
		{
			Near->bTalked = true;
			Score += 150;
			if (Objective == TEXT("talk") && ++Progress >= Target) { Finish(true); }
		}
	}
}

void AIpverseGameMode::OnEnemyKilled(AIpverseEnemy* Enemy)
{
	Alive = FMath::Max(0, Alive - 1);
	Score += 100;
	if (Phase == EPhase::Playing && Objective == TEXT("kills") && ++Progress >= Target)
	{
		Finish(true);
	}
}

void AIpverseGameMode::OnPickup(AIpversePickup* Pickup, AIpverseCharacter* InPlayer)
{
	if (Phase != EPhase::Playing)
	{
		return;
	}
	const FString& Effect = Pickup->Effect;
	if (Effect == TEXT("heal")) { InPlayer->Heal(35.f); }
	else if (Effect == TEXT("shield")) { InPlayer->AddShield(8.f); }
	Score += Effect == TEXT("score") ? 120 : 40;
	if (Objective == TEXT("collect") && Effect == TEXT("key") && ++Progress >= Target)
	{
		Finish(true);
	}
}

void AIpverseGameMode::OnPlayerDied()
{
	if (Phase == EPhase::Playing)
	{
		Finish(false);
	}
}

void AIpverseGameMode::Finish(bool bWon)
{
	Phase = bWon ? EPhase::Won : EPhase::Lost;
	EndedAt = GetWorld()->GetTimeSeconds();
	Talking = nullptr;
	if (Player)
	{
		Player->Freeze(); // input stays bound so R restarts
	}
	UE_LOG(LogIpverse, Log, TEXT("Game over: %s, score %d"), bWon ? TEXT("won") : TEXT("lost"), Score);
}

void AIpverseGameMode::RequestRestart()
{
	if (Phase == EPhase::Won || Phase == EPhase::Lost)
	{
		UGameplayStatics::OpenLevel(this, FName(*UGameplayStatics::GetCurrentLevelName(this)));
	}
}

FString AIpverseGameMode::ObjectiveText() const
{
	if (Objective == TEXT("kills")) { return FString::Printf(TEXT("적 처치 %d / %d"), Progress, Target); }
	if (Objective == TEXT("survive")) { return FString::Printf(TEXT("생존 %d / %d초"), Progress, Target); }
	if (Objective == TEXT("collect")) { return FString::Printf(TEXT("유물 수집 %d / %d"), Progress, Target); }
	return FString::Printf(TEXT("주민과 대화 %d / %d"), Progress, Target);
}

void AIpverseGameMode::UpdateHud()
{
	AIpverseHud* H = Hud();
	if (!H)
	{
		return;
	}
	FIpverseHudState& S = H->State;
	S.Accent = Spec ? Spec->Accent : S.Accent;
	S.bLoading = Phase == EPhase::Loading;
	S.LoadingText = TEXT("게임 준비 중…  IP 캐릭터와 월드를 불러오고 있어요");
	if (Phase == EPhase::Loading || !Spec)
	{
		return;
	}
	S.Title = Spec->QuestTitle.IsEmpty() ? Spec->Title : Spec->Title + TEXT(" · ") + Spec->QuestTitle;
	S.Objective = ObjectiveText();
	S.Score = Score;
	S.bCrosshair = bArena;
	S.Help = bArena ? TEXT("WASD 이동 · 마우스 조준 · 클릭 사격 · Space 점프") : TEXT("WASD 이동 · 마우스 시점 · Space 점프 · E 대화");
	if (Player)
	{
		S.Health01 = Player->Health / Player->MaxHealth;
		S.bShield = Player->HasShield();
		S.Hurt = Player->GetHurtFlash();
	}
	S.Prompt.Empty();
	S.DialogueName.Empty();
	S.DialogueText.Empty();
	if (Talking && Talking->Lines.IsValidIndex(Talking->NextLine))
	{
		S.DialogueName = Talking->Name;
		S.DialogueText = Talking->Lines[Talking->NextLine];
		S.Prompt = TEXT("E  다음");
	}
	else if (!bArena && Player && Phase == EPhase::Playing)
	{
		for (AIpverseNpc* Npc : Npcs)
		{
			if (Npc && FVector::Dist2D(Npc->GetActorLocation(), Player->GetActorLocation()) < 450.f)
			{
				S.Prompt = FString::Printf(TEXT("E  %s와(과) 대화하기"), *Npc->Name);
				break;
			}
		}
	}
	S.Banner = Phase == EPhase::Won ? TEXT("승리!") : Phase == EPhase::Lost ? TEXT("패배…") : TEXT("");
	S.BannerSub = Phase == EPhase::Playing ? TEXT("") : FString::Printf(TEXT("점수 %d  ·  R 키로 다시 하기"), Score);
}

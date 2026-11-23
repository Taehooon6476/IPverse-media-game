#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "IpverseGameMode.generated.h"

class AIpverseCharacter;
class AIpverseEnemy;
class AIpverseEnvironment;
class AIpverseHud;
class AIpverseLevel;
class AIpverseNpc;
class AIpversePickup;
class UIpverseSpecSubsystem;

/**
 * The one GameMode of the one map (/Game/Ipverse/Maps/Main). Waits for the manifest, then builds the template
 * for the genre (sf-* arena, rpg-* valley), spawns the IP player, enemies, props and NPCs from the GameSpec and
 * runs the objective (kills | survive | collect | talk) to a win/lose banner. R restarts.
 */
UCLASS()
class IPVERSEGAME_API AIpverseGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	AIpverseGameMode();

	virtual void HandleStartingNewPlayer_Implementation(APlayerController* NewPlayer) override;
	virtual void Tick(float DeltaSeconds) override;

	void Interact(AIpverseCharacter* Player);
	void RequestRestart();
	void OnPlayerDied();
	void OnEnemyKilled(AIpverseEnemy* Enemy);
	void OnPickup(AIpversePickup* Pickup, AIpverseCharacter* Player);

protected:
	virtual void BeginPlay() override;

private:
	enum class EPhase : uint8 { Loading, Playing, Won, Lost };

	void HandleLoaded(bool bSuccess);
	void StartGame();
	void SpawnEnemy(bool bNearPlayerRing);
	void SpawnPickup(int32 EntityIndex, const FVector& At);
	void Finish(bool bWon);
	void UpdateHud();
	AIpverseHud* Hud() const;
	FString ObjectiveText() const;

	EPhase Phase = EPhase::Loading;
	TObjectPtr<UIpverseSpecSubsystem> Spec;
	UPROPERTY() TObjectPtr<AIpverseEnvironment> Environment;
	UPROPERTY() TObjectPtr<AIpverseLevel> Level;
	UPROPERTY() TObjectPtr<AIpverseCharacter> Player;
	UPROPERTY() TArray<TObjectPtr<AIpverseNpc>> Npcs;
	UPROPERTY() TObjectPtr<AIpverseNpc> Talking;

	FRandomStream Rng;
	bool bArena = true;
	FString Objective;
	int32 Target = 10;
	int32 Progress = 0;
	int32 Score = 0;
	float Elapsed = 0.f;
	float NextSpawn = 0.f;
	int32 MaxAlive = 5;
	int32 Alive = 0;
	int32 EnemyCursor = 0;
	float DifficultyScale = 1.f;
	float EndedAt = 0.f;
};

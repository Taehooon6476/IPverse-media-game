#include "IpverseEnemy.h"
#include "IpverseAssets.h"
#include "IpverseCharacter.h"
#include "IpverseGameMode.h"
#include "IpverseProceduralMotionComponent.h"
#include "IpverseProjectile.h"

#include "AIController.h"
#include "Components/CapsuleComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/World.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "Kismet/GameplayStatics.h"
#include "Materials/MaterialInstanceDynamic.h"

using namespace IpverseAssets;

AIpverseEnemy::AIpverseEnemy()
{
	PrimaryActorTick.bCanEverTick = true;
	AIControllerClass = AAIController::StaticClass();
	AutoPossessAI = EAutoPossessAI::PlacedInWorldOrSpawned; // a controller makes AddMovementInput drive the CMC
	GetCapsuleComponent()->InitCapsuleSize(55.f, 85.f);
	GetMesh()->SetVisibility(false);

	Motion = CreateDefaultSubobject<UIpverseProceduralMotionComponent>(TEXT("Motion"));
	Motion->SetupAttachment(RootComponent);
	Motion->BobHeight = 12.f;
	Motion->StepsPerSecond = 5.f;

	Body = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Body"));
	Body->SetupAttachment(Motion);
	Body->SetCollisionEnabled(ECollisionEnabled::NoCollision);

	GetCharacterMovement()->bOrientRotationToMovement = true;
	GetCharacterMovement()->RotationRate = FRotator(0.f, 420.f, 0.f);
	bUseControllerRotationYaw = false;
}

void AIpverseEnemy::ApplyEntity(const FIpverseEntity& Entity, float DifficultyScale, float InAggroRange)
{
	AggroRange = InAggroRange;
	Home = GetActorLocation();
	Hp = FMath::Clamp(Entity.Hp, 1, 3) * 2;
	ContactDps = 16.f * DifficultyScale;
	GetCharacterMovement()->MaxWalkSpeed = (230.f + 90.f * FMath::Clamp(Entity.Speed, 1, 3)) * FMath::Sqrt(DifficultyScale);
	const float Foot = -GetCapsuleComponent()->GetScaledCapsuleHalfHeight();
	if (Entity.Mesh)
	{
		FitMesh(Body, Entity.Mesh, 170.f, Foot, Entity.YawOffset);
		return;
	}
	EShape S = EShape::Sphere;
	if (Entity.Shape == TEXT("triangle")) { S = EShape::Cone; }
	else if (Entity.Shape == TEXT("square")) { S = EShape::Cube; }
	Skin = Tinted(this, TEXT("M_Glow"), Entity.Color, GlowBase);
	Body->SetStaticMesh(Shape(S));
	Body->SetMaterial(0, Skin);
	Body->SetRelativeTransform(FTransform(FRotator(0.f, 45.f, 0.f), FVector(0, 0, Foot + 75.f), FVector(1.3f)));
	// dark armour ring so the glow reads as a core
	UStaticMeshComponent* Ring = AddMesh(this, Shape(EShape::Cylinder), Tinted(this, TEXT("M_Surface"), FLinearColor(0.03f, 0.03f, 0.04f)),
		FTransform(FRotator::ZeroRotator, FVector(0, 0, Foot + 70.f), FVector(1.45f, 1.45f, 0.18f)), false);
	Ring->AttachToComponent(Motion, FAttachmentTransformRules::KeepRelativeTransform);
}

void AIpverseEnemy::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	AIpverseCharacter* Player = Cast<AIpverseCharacter>(UGameplayStatics::GetPlayerPawn(this, 0));
	const float Now = GetWorld()->GetTimeSeconds();
	if (Player && Player->Health > 0.f)
	{
		const FVector To = Player->GetActorLocation() - GetActorLocation();
		const float Dist = To.Size2D();
		if (Dist < AggroRange)
		{
			AddMovementInput(FVector(To.X, To.Y, 0.f).GetSafeNormal());
			if (Dist < 150.f && FMath::Abs(To.Z) < 200.f)
			{
				Player->TakeHit(ContactDps * DeltaSeconds);
			}
		}
		else
		{
			if (Now > NextWander || FVector::Dist2D(GetActorLocation(), WanderTarget) < 150.f)
			{
				WanderTarget = Home + FVector(FMath::FRandRange(-900.f, 900.f), FMath::FRandRange(-900.f, 900.f), 0.f);
				NextWander = Now + FMath::FRandRange(3.f, 6.f);
			}
			AddMovementInput((WanderTarget - GetActorLocation()).GetSafeNormal2D(), 0.4f);
		}
	}
	if (Skin && Flash > 0.f)
	{
		Flash = FMath::Max(0.f, Flash - DeltaSeconds * 6.f);
		Skin->SetScalarParameterValue(TEXT("Glow"), GlowBase + Flash * 80.f);
	}
}

void AIpverseEnemy::TakeHit(int32 Damage)
{
	if (Hp <= 0)
	{
		return;
	}
	Hp -= Damage;
	Flash = 1.f;
	if (Hp > 0)
	{
		return;
	}
	AIpverseProjectile::SpawnTracer(GetWorld(), GetActorLocation() + FVector(0, 0, 60.f), GetActorLocation() + FVector(0, 0, 61.f),
		FLinearColor(1.f, 0.6f, 0.2f), true); // burst
	if (AIpverseGameMode* GM = GetWorld()->GetAuthGameMode<AIpverseGameMode>())
	{
		GM->OnEnemyKilled(this);
	}
	Destroy();
}

#include "IpverseCharacter.h"
#include "IpverseAssets.h"
#include "IpverseEnemy.h"
#include "IpverseGameMode.h"
#include "IpverseProceduralMotionComponent.h"
#include "IpverseProjectile.h"

#include "Camera/CameraComponent.h"
#include "Components/CapsuleComponent.h"
#include "Components/InputComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/World.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/SpringArmComponent.h"
#include "InputCoreTypes.h"
#include "Materials/MaterialInstanceDynamic.h"

using namespace IpverseAssets;

AIpverseCharacter::AIpverseCharacter()
{
	PrimaryActorTick.bCanEverTick = true;
	GetCapsuleComponent()->InitCapsuleSize(40.f, 90.f);
	GetMesh()->SetVisibility(false); // no skeleton: the IP mesh rides on Motion

	Boom = CreateDefaultSubobject<USpringArmComponent>(TEXT("Boom"));
	Boom->SetupAttachment(RootComponent);
	Boom->TargetArmLength = 420.f;
	Boom->SocketOffset = FVector(0.f, 55.f, 75.f);
	Boom->bUsePawnControlRotation = true;
	Boom->bEnableCameraLag = true;
	Boom->CameraLagSpeed = 14.f;

	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(Boom, USpringArmComponent::SocketName);
	Camera->SetFieldOfView(80.f);

	Motion = CreateDefaultSubobject<UIpverseProceduralMotionComponent>(TEXT("Motion"));
	Motion->SetupAttachment(RootComponent);

	Body = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Body"));
	Body->SetupAttachment(Motion);
	Body->SetCollisionEnabled(ECollisionEnabled::NoCollision);

	UCharacterMovementComponent* Move = GetCharacterMovement();
	Move->JumpZVelocity = 640.f;
	Move->AirControl = 0.4f;
	Move->RotationRate = FRotator(0.f, 600.f, 0.f);
	Move->BrakingDecelerationWalking = 1800.f;
	Move->MaxStepHeight = 60.f;
	Move->SetWalkableFloorAngle(50.f);
}

void AIpverseCharacter::ApplyEntity(const FIpverseEntity& Entity, const FLinearColor& Accent, bool bInShooter)
{
	bShooter = bInShooter;
	TracerColor = Accent;
	const float Foot = -GetCapsuleComponent()->GetScaledCapsuleHalfHeight();
	if (Entity.Mesh)
	{
		FitMesh(Body, Entity.Mesh, 180.f, Foot, Entity.YawOffset);
	}
	else
	{
		BuildPlaceholder(Accent);
	}
	GetCharacterMovement()->MaxWalkSpeed = 420.f + 90.f * FMath::Clamp(Entity.Speed, 1, 3);
	// shooter: body faces the crosshair (strafe); explorer: body turns towards movement
	bUseControllerRotationYaw = bShooter;
	GetCharacterMovement()->bOrientRotationToMovement = !bShooter;

	ShieldBubble = AddMesh(this, Shape(EShape::Sphere), Tinted(this, TEXT("M_Glow"), FLinearColor(0.3f, 0.7f, 1.f), 2.f),
		FTransform(FRotator::ZeroRotator, FVector::ZeroVector, FVector(2.3f)), false);
	ShieldBubble->SetVisibility(false);
	ShieldBubble->SetCastShadow(false);
}

void AIpverseCharacter::BuildPlaceholder(const FLinearColor& Accent)
{
	// a sleek capsule robot: torso, head, glowing visor and core
	const float Foot = -GetCapsuleComponent()->GetScaledCapsuleHalfHeight();
	UMaterialInstanceDynamic* Shell = Tinted(this, TEXT("M_Surface"), FLinearColor(0.85f, 0.87f, 0.9f));
	Shell->SetScalarParameterValue(TEXT("Roughness"), 0.25f);
	UMaterialInstanceDynamic* Glow = Tinted(this, TEXT("M_Glow"), Accent, 25.f);
	auto Part = [this](UStaticMesh* M, UMaterialInterface* Mat, const FVector& Loc, const FVector& Scale) {
		UStaticMeshComponent* C = NewObject<UStaticMeshComponent>(this);
		C->SetStaticMesh(M);
		C->SetMaterial(0, Mat);
		C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		C->SetupAttachment(Motion);
		C->SetRelativeTransform(FTransform(FRotator::ZeroRotator, Loc, Scale));
		C->RegisterComponent();
		Placeholder.Add(C);
	};
	Part(Shape(EShape::Cylinder), Shell, FVector(0, 0, Foot + 70.f), FVector(0.55f, 0.55f, 1.1f));
	Part(Shape(EShape::Sphere), Shell, FVector(0, 0, Foot + 150.f), FVector(0.5f));
	Part(Shape(EShape::Cube), Glow, FVector(22.f, 0, Foot + 155.f), FVector(0.1f, 0.38f, 0.1f));
	Part(Shape(EShape::Sphere), Glow, FVector(26.f, 0, Foot + 95.f), FVector(0.12f));
}

void AIpverseCharacter::SetupPlayerInputComponent(UInputComponent* Input)
{
	Super::SetupPlayerInputComponent(Input);
	Input->BindAxisKey(EKeys::W, this, &AIpverseCharacter::Forward);
	Input->BindAxisKey(EKeys::Up, this, &AIpverseCharacter::Forward);
	Input->BindAxisKey(EKeys::S, this, &AIpverseCharacter::Back);
	Input->BindAxisKey(EKeys::Down, this, &AIpverseCharacter::Back);
	Input->BindAxisKey(EKeys::D, this, &AIpverseCharacter::Right);
	Input->BindAxisKey(EKeys::Right, this, &AIpverseCharacter::Right);
	Input->BindAxisKey(EKeys::A, this, &AIpverseCharacter::Left);
	Input->BindAxisKey(EKeys::Left, this, &AIpverseCharacter::Left);
	Input->BindAxisKey(EKeys::MouseX, this, &AIpverseCharacter::Turn);
	Input->BindAxisKey(EKeys::MouseY, this, &AIpverseCharacter::LookUp);
	Input->BindKey(EKeys::SpaceBar, IE_Pressed, this, &ACharacter::Jump);
	Input->BindKey(EKeys::SpaceBar, IE_Released, this, &ACharacter::StopJumping);
	Input->BindKey(EKeys::LeftMouseButton, IE_Pressed, this, &AIpverseCharacter::FireDown);
	Input->BindKey(EKeys::LeftMouseButton, IE_Released, this, &AIpverseCharacter::FireUp);
	Input->BindKey(EKeys::E, IE_Pressed, this, &AIpverseCharacter::Interact);
	Input->BindKey(EKeys::Enter, IE_Pressed, this, &AIpverseCharacter::Interact);
	Input->BindKey(EKeys::R, IE_Pressed, this, &AIpverseCharacter::RestartGame);
}

void AIpverseCharacter::Turn(float V)
{
	AddControllerYawInput(V * 0.6f);
}

void AIpverseCharacter::LookUp(float V)
{
	AddControllerPitchInput(-V * 0.6f); // same sign convention as the UE third-person template (MouseY scale -1)
}

void AIpverseCharacter::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	if (Controller && !bFrozen)
	{
		const FRotator Yaw(0.f, Controller->GetControlRotation().Yaw, 0.f);
		const FVector2D In = MoveInput.GetClampedToMaxSize(1.f);
		AddMovementInput(Yaw.RotateVector(FVector::ForwardVector), In.X);
		AddMovementInput(Yaw.RotateVector(FVector::RightVector), In.Y);
	}
	MoveInput = FVector2D::ZeroVector;

	const float Now = GetWorld()->GetTimeSeconds();
	if (bShooter && bFiring && !bFrozen && Now >= NextShot)
	{
		NextShot = Now + 0.14f;
		Fire();
	}
	if (ShieldBubble)
	{
		ShieldBubble->SetVisibility(HasShield());
	}
	HurtFlash = FMath::Max(0.f, HurtFlash - DeltaSeconds * 3.f); // the HUD draws it as a red vignette
	if (GetActorLocation().Z < -5000.f) // fell off the world
	{
		TakeHit(1000.f);
	}
}

void AIpverseCharacter::Fire()
{
	APlayerController* PC = Cast<APlayerController>(Controller);
	if (!PC)
	{
		return;
	}
	FVector CamLoc;
	FRotator CamRot;
	PC->GetPlayerViewPoint(CamLoc, CamRot);
	const FVector Muzzle = GetActorLocation() + GetActorForwardVector() * 60.f + FVector(0, 0, 45.f);
	const FVector Start = CamLoc + CamRot.Vector() * (Boom->TargetArmLength + 60.f);
	const FVector End = CamLoc + CamRot.Vector() * 9000.f;

	FCollisionObjectQueryParams Objects;
	Objects.AddObjectTypesToQuery(ECC_Pawn);
	Objects.AddObjectTypesToQuery(ECC_WorldStatic);
	Objects.AddObjectTypesToQuery(ECC_WorldDynamic);
	FCollisionQueryParams Params(SCENE_QUERY_STAT(IpverseFire), false, this);
	FHitResult Hit;
	const bool bHit = GetWorld()->SweepSingleByObjectType(Hit, Start, End, FQuat::Identity, Objects,
		FCollisionShape::MakeSphere(18.f), Params);
	const FVector Target = bHit ? Hit.ImpactPoint : End;
	if (AIpverseEnemy* Enemy = bHit ? Cast<AIpverseEnemy>(Hit.GetActor()) : nullptr)
	{
		Enemy->TakeHit(1);
	}
	AIpverseProjectile::SpawnTracer(GetWorld(), Muzzle, Target, TracerColor, bHit);
}

void AIpverseCharacter::Interact()
{
	if (AIpverseGameMode* GM = GetWorld()->GetAuthGameMode<AIpverseGameMode>())
	{
		GM->Interact(this);
	}
}

void AIpverseCharacter::RestartGame()
{
	if (AIpverseGameMode* GM = GetWorld()->GetAuthGameMode<AIpverseGameMode>())
	{
		GM->RequestRestart();
	}
}

bool AIpverseCharacter::HasShield() const
{
	return GetWorld() && GetWorld()->GetTimeSeconds() < ShieldUntil;
}

void AIpverseCharacter::TakeHit(float Amount)
{
	if (Health <= 0.f || (HasShield() && Amount < 1000.f))
	{
		return;
	}
	Health = FMath::Max(0.f, Health - Amount);
	HurtFlash = 1.f;
	if (Health <= 0.f)
	{
		if (AIpverseGameMode* GM = GetWorld()->GetAuthGameMode<AIpverseGameMode>())
		{
			GM->OnPlayerDied();
		}
	}
}

void AIpverseCharacter::Heal(float Amount)
{
	Health = FMath::Min(MaxHealth, Health + Amount);
}

void AIpverseCharacter::AddShield(float Seconds)
{
	ShieldUntil = FMath::Max(ShieldUntil, GetWorld()->GetTimeSeconds()) + Seconds;
}

void AIpverseCharacter::Freeze()
{
	bFrozen = true;
	bFiring = false;
	GetCharacterMovement()->StopMovementImmediately();
}

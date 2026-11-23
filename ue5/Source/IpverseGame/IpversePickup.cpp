#include "IpversePickup.h"
#include "IpverseAssets.h"
#include "IpverseCharacter.h"
#include "IpverseGameMode.h"

#include "Components/PointLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Engine/World.h"
#include "Kismet/GameplayStatics.h"

using namespace IpverseAssets;

AIpversePickup::AIpversePickup()
{
	PrimaryActorTick.bCanEverTick = true;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	RootComponent->SetMobility(EComponentMobility::Movable);
	Spin = CreateDefaultSubobject<USceneComponent>(TEXT("Spin"));
	Spin->SetupAttachment(RootComponent);
	Body = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Body"));
	Body->SetupAttachment(Spin);
	Body->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Light = CreateDefaultSubobject<UPointLightComponent>(TEXT("Light"));
	Light->SetupAttachment(RootComponent);
	Light->SetRelativeLocation(FVector(0, 0, 60.f));
	Light->SetIntensity(6000.f);
	Light->SetAttenuationRadius(450.f);
	Light->SetCastShadows(false);
}

void AIpversePickup::ApplyEntity(const FIpverseEntity& Entity)
{
	Effect = Entity.Effect.IsEmpty() ? TEXT("score") : Entity.Effect;
	Label = Entity.Name;
	BaseZ = GetActorLocation().Z;
	FLinearColor Color(1.f, 0.85f, 0.3f);
	EShape S = EShape::Cube;
	if (Effect == TEXT("heal")) { Color = FLinearColor(0.25f, 1.f, 0.45f); S = EShape::Sphere; }
	else if (Effect == TEXT("shield")) { Color = FLinearColor(0.3f, 0.65f, 1.f); S = EShape::Cylinder; }
	else if (Effect == TEXT("key")) { Color = FLinearColor(1.f, 0.75f, 0.2f); S = EShape::Cone; }
	Light->SetLightColor(Color);
	if (Entity.Mesh)
	{
		FitMesh(Body, Entity.Mesh, 80.f, 20.f, Entity.YawOffset);
	}
	else
	{
		Body->SetStaticMesh(Shape(S));
		Body->SetMaterial(0, Tinted(this, TEXT("M_Glow"), Color, 12.f));
		Body->SetRelativeTransform(FTransform(FRotator(0.f, 0.f, S == EShape::Cube ? 45.f : 0.f), FVector(0, 0, 60.f), FVector(0.45f)));
	}
	// glowing base ring so props read as pickups even with an IP mesh
	AddMesh(this, Shape(EShape::Cylinder), Tinted(this, TEXT("M_Glow"), Color, 8.f),
		FTransform(FRotator::ZeroRotator, FVector(0, 0, 3.f), FVector(1.1f, 1.1f, 0.02f)), false)->SetCastShadow(false);
}

void AIpversePickup::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	Time += DeltaSeconds;
	Spin->SetRelativeRotation(FRotator(0.f, Time * 90.f, 0.f));
	Spin->SetRelativeLocation(FVector(0, 0, 12.f * FMath::Sin(Time * 2.5f)));

	AIpverseCharacter* Player = Cast<AIpverseCharacter>(UGameplayStatics::GetPlayerPawn(this, 0));
	if (Player && FVector::Dist(Player->GetActorLocation(), GetActorLocation() + FVector(0, 0, 60.f)) < 150.f)
	{
		if (AIpverseGameMode* GM = GetWorld()->GetAuthGameMode<AIpverseGameMode>())
		{
			GM->OnPickup(this, Player);
		}
		Destroy();
	}
}

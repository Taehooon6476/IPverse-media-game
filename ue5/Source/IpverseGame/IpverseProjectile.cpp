#include "IpverseProjectile.h"
#include "IpverseAssets.h"

#include "Components/PointLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Engine/World.h"

using namespace IpverseAssets;

AIpverseProjectile::AIpverseProjectile()
{
	PrimaryActorTick.bCanEverTick = true;
	Bolt = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Bolt"));
	RootComponent = Bolt;
	Bolt->SetMobility(EComponentMobility::Movable);
	Bolt->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Bolt->SetCastShadow(false);

	Light = CreateDefaultSubobject<UPointLightComponent>(TEXT("Light"));
	Light->SetupAttachment(Bolt);
	Light->SetMobility(EComponentMobility::Movable);
	Light->SetIntensity(9000.f);
	Light->SetAttenuationRadius(500.f);
	Light->SetCastShadows(false);
}

void AIpverseProjectile::SpawnTracer(UWorld* World, const FVector& InFrom, const FVector& InTo, const FLinearColor& Color, bool bInImpact)
{
	if (!World)
	{
		return;
	}
	const FRotator Dir = (InTo - InFrom).Rotation();
	AIpverseProjectile* P = World->SpawnActor<AIpverseProjectile>(InFrom, Dir);
	if (!P)
	{
		return;
	}
	P->From = InFrom;
	P->To = InTo;
	P->bImpact = bInImpact;
	P->Duration = FMath::Max(0.03f, FVector::Dist(InFrom, InTo) / 9000.f);
	P->Bolt->SetStaticMesh(Shape(EShape::Sphere));
	P->Bolt->SetMaterial(0, Tinted(P, TEXT("M_Glow"), Color, 60.f));
	P->Bolt->SetWorldScale3D(FVector(1.1f, 0.12f, 0.12f)); // stretched along the flight direction
	P->Light->SetLightColor(Color);
	P->SetLifeSpan(3.f);
}

void AIpverseProjectile::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	if (Alpha < 1.f)
	{
		Alpha = FMath::Min(1.f, Alpha + DeltaSeconds / Duration);
		SetActorLocation(FMath::Lerp(From, To, Alpha));
		if (Alpha >= 1.f)
		{
			if (!bImpact)
			{
				Destroy();
				return;
			}
			FlashLeft = 0.09f;
			Bolt->SetWorldScale3D(FVector(0.45f));
			Light->SetIntensity(40000.f);
			Light->SetAttenuationRadius(700.f);
		}
		return;
	}
	FlashLeft -= DeltaSeconds;
	if (FlashLeft <= 0.f)
	{
		Destroy();
	}
}

#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "IpverseProjectile.generated.h"

class UStaticMeshComponent;
class UPointLightComponent;

/** Visual-only plasma bolt: flies muzzle -> hit point (damage is a hit-scan sweep), flashes on impact. */
UCLASS()
class IPVERSEGAME_API AIpverseProjectile : public AActor
{
	GENERATED_BODY()

public:
	AIpverseProjectile();

	static void SpawnTracer(UWorld* World, const FVector& From, const FVector& To, const FLinearColor& Color, bool bImpact);

	virtual void Tick(float DeltaSeconds) override;

	UPROPERTY(VisibleAnywhere) TObjectPtr<UStaticMeshComponent> Bolt;
	UPROPERTY(VisibleAnywhere) TObjectPtr<UPointLightComponent> Light;

private:
	FVector From = FVector::ZeroVector;
	FVector To = FVector::ZeroVector;
	float Alpha = 0.f;
	float Duration = 0.1f;
	float FlashLeft = 0.f;
	bool bImpact = false;
};

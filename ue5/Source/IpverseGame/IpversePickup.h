#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "IpverseSpecSubsystem.h"
#include "IpversePickup.generated.h"

class UStaticMeshComponent;
class UPointLightComponent;

/** Floating, spinning pickup: heal | score | shield | key. IP prop mesh when the manifest has one. */
UCLASS()
class IPVERSEGAME_API AIpversePickup : public AActor
{
	GENERATED_BODY()

public:
	AIpversePickup();

	void ApplyEntity(const FIpverseEntity& Entity);
	FString Effect = TEXT("score");
	FString Label;

	virtual void Tick(float DeltaSeconds) override;

	UPROPERTY(VisibleAnywhere) TObjectPtr<USceneComponent> Spin;
	UPROPERTY(VisibleAnywhere) TObjectPtr<UStaticMeshComponent> Body;
	UPROPERTY(VisibleAnywhere) TObjectPtr<UPointLightComponent> Light;

private:
	float Time = 0.f;
	float BaseZ = 0.f;
};

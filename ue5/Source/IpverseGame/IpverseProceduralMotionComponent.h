// NOT COMPILED IN THIS REPO.
#pragma once

#include "CoreMinimal.h"
#include "Components/SceneComponent.h"
#include "IpverseProceduralMotionComponent.generated.h"

/**
 * Generated IP meshes are static (no skeleton). Parent the IP StaticMeshComponent to this component and it
 * fakes locomotion from the owner's velocity: hop/bob, forward lean, squash on landing, idle breathing.
 * Replaced by real skinning once the offline auto-rig step exists (docs/ue5/design.md, "rigging").
 */
UCLASS(ClassGroup = (Ipverse), meta = (BlueprintSpawnableComponent))
class IPVERSEGAME_API UIpverseProceduralMotionComponent : public USceneComponent
{
	GENERATED_BODY()

public:
	UPROPERTY(EditAnywhere, Category = "Motion") float BobHeight = 6.f;      // cm at full run speed
	UPROPERTY(EditAnywhere, Category = "Motion") float StepsPerSecond = 4.f; // at full run speed
	UPROPERTY(EditAnywhere, Category = "Motion") float MaxLeanDegrees = 10.f;
	UPROPERTY(EditAnywhere, Category = "Motion") float RunSpeed = 600.f;     // cm/s mapped to 1.0
	UPROPERTY(EditAnywhere, Category = "Motion") float BreathScale = 0.015f;

	UIpverseProceduralMotionComponent();
	virtual void TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction) override;

private:
	float Phase = 0.f;
	float Time = 0.f;
};

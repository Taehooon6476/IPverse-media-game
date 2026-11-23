// NOT COMPILED IN THIS REPO.
#include "IpverseProceduralMotionComponent.h"
#include "GameFramework/Actor.h"

UIpverseProceduralMotionComponent::UIpverseProceduralMotionComponent()
{
	PrimaryComponentTick.bCanEverTick = true;
}

void UIpverseProceduralMotionComponent::TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction)
{
	Super::TickComponent(DeltaTime, TickType, ThisTickFunction);

	const AActor* Owner = GetOwner();
	const FVector Velocity = Owner ? Owner->GetVelocity() : FVector::ZeroVector;
	const float Speed01 = FMath::Clamp(Velocity.Size2D() / RunSpeed, 0.f, 1.f);

	Time += DeltaTime;
	Phase += DeltaTime * StepsPerSecond * Speed01 * UE_TWO_PI;

	// Hop: |sin| gives one bump per step; squash a little at the bottom of each step.
	const float Step = FMath::Abs(FMath::Sin(Phase));
	const float Bob = BobHeight * Speed01 * Step;
	const float Squash = 1.f - 0.06f * Speed01 * (1.f - Step);
	const float Breath = 1.f + BreathScale * (1.f - Speed01) * FMath::Sin(Time * 2.f);

	// Lean into the direction of travel (relative to the actor's facing).
	const FVector LocalVel = Owner ? Owner->GetActorTransform().InverseTransformVectorNoScale(Velocity) : FVector::ZeroVector;
	const float Pitch = -MaxLeanDegrees * FMath::Clamp(LocalVel.X / RunSpeed, -1.f, 1.f);
	const float Roll = MaxLeanDegrees * 0.5f * FMath::Clamp(LocalVel.Y / RunSpeed, -1.f, 1.f);

	SetRelativeLocation(FVector(0.f, 0.f, Bob));
	SetRelativeRotation(FRotator(Pitch, 0.f, Roll));
	SetRelativeScale3D(FVector(1.f / FMath::Sqrt(Squash), 1.f / FMath::Sqrt(Squash), Squash * Breath));
}

#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "IpverseSpecSubsystem.h"
#include "IpverseCharacter.generated.h"

class USpringArmComponent;
class UCameraComponent;
class UStaticMeshComponent;
class UIpverseProceduralMotionComponent;

/** The IP as the playable third-person character: unrigged GLB on a procedural-motion rig, ~1.8 m tall. */
UCLASS()
class IPVERSEGAME_API AIpverseCharacter : public ACharacter
{
	GENERATED_BODY()

public:
	AIpverseCharacter();

	void ApplyEntity(const FIpverseEntity& Entity, const FLinearColor& Accent, bool bShooter);
	void TakeHit(float Amount);
	void Heal(float Amount);
	void AddShield(float Seconds);
	void Freeze();

	float Health = 100.f;
	float MaxHealth = 100.f;
	bool HasShield() const;
	bool IsShooter() const { return bShooter; }
	float GetHurtFlash() const { return HurtFlash; }

	UPROPERTY(VisibleAnywhere) TObjectPtr<USpringArmComponent> Boom;
	UPROPERTY(VisibleAnywhere) TObjectPtr<UCameraComponent> Camera;
	UPROPERTY(VisibleAnywhere) TObjectPtr<UIpverseProceduralMotionComponent> Motion;
	UPROPERTY(VisibleAnywhere) TObjectPtr<UStaticMeshComponent> Body;

protected:
	virtual void SetupPlayerInputComponent(UInputComponent* Input) override;
	virtual void Tick(float DeltaSeconds) override;

private:
	void Forward(float V) { MoveInput.X += V; }
	void Back(float V) { MoveInput.X -= V; }
	void Right(float V) { MoveInput.Y += V; }
	void Left(float V) { MoveInput.Y -= V; }
	void Turn(float V);
	void LookUp(float V);
	void FireDown() { bFiring = true; }
	void FireUp() { bFiring = false; }
	void Interact();
	void RestartGame();
	void Fire();
	void BuildPlaceholder(const FLinearColor& Accent);

	FVector2D MoveInput = FVector2D::ZeroVector;
	bool bShooter = true;
	bool bFiring = false;
	bool bFrozen = false;
	float NextShot = 0.f;
	float ShieldUntil = 0.f;
	float HurtFlash = 0.f;
	FLinearColor TracerColor = FLinearColor(0.3f, 0.9f, 1.f);
	UPROPERTY() TArray<TObjectPtr<UStaticMeshComponent>> Placeholder;
	UPROPERTY() TObjectPtr<UStaticMeshComponent> ShieldBubble;
};

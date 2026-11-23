#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "IpverseSpecSubsystem.h"
#include "IpverseEnemy.generated.h"

class UStaticMeshComponent;
class UMaterialInstanceDynamic;
class UIpverseProceduralMotionComponent;

/** Chaser: IP mesh or a glowing shape (triangle=cone, circle=sphere, square=cube); contact damage. */
UCLASS()
class IPVERSEGAME_API AIpverseEnemy : public ACharacter
{
	GENERATED_BODY()

public:
	AIpverseEnemy();

	void ApplyEntity(const FIpverseEntity& Entity, float DifficultyScale, float InAggroRange);
	void TakeHit(int32 Damage);

	virtual void Tick(float DeltaSeconds) override;

	UPROPERTY(VisibleAnywhere) TObjectPtr<UIpverseProceduralMotionComponent> Motion;
	UPROPERTY(VisibleAnywhere) TObjectPtr<UStaticMeshComponent> Body;

private:
	int32 Hp = 2;
	float ContactDps = 18.f;
	float AggroRange = 1e9f;
	float Flash = 0.f;
	float GlowBase = 6.f;
	FVector Home = FVector::ZeroVector;
	FVector WanderTarget = FVector::ZeroVector;
	float NextWander = 0.f;
	UPROPERTY() TObjectPtr<UMaterialInstanceDynamic> Skin;
};

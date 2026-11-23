#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "IpverseSpecSubsystem.h"
#include "IpverseNpc.generated.h"

class UStaticMeshComponent;
class UPointLightComponent;
class UIpverseProceduralMotionComponent;

/** Quest giver: IP mesh (manifest role npc) or a robed placeholder, a beacon light, and lines to say. */
UCLASS()
class IPVERSEGAME_API AIpverseNpc : public AActor
{
	GENERATED_BODY()

public:
	AIpverseNpc();

	void Setup(const FIpverseEntity* Entity, const FString& InName, const TArray<FString>& InLines, const FLinearColor& Accent);

	virtual void Tick(float DeltaSeconds) override;

	FString Name;
	TArray<FString> Lines;
	int32 NextLine = 0;
	bool bTalked = false;

	UPROPERTY(VisibleAnywhere) TObjectPtr<UIpverseProceduralMotionComponent> Motion;
	UPROPERTY(VisibleAnywhere) TObjectPtr<UStaticMeshComponent> Body;
	UPROPERTY(VisibleAnywhere) TObjectPtr<UStaticMeshComponent> Marker;
	UPROPERTY(VisibleAnywhere) TObjectPtr<UPointLightComponent> Beacon;

private:
	float Time = 0.f;
};

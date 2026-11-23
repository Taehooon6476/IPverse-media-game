#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "IpverseEnvironment.generated.h"

class UDirectionalLightComponent;
class USkyAtmosphereComponent;
class USkyLightComponent;
class UVolumetricCloudComponent;
class UExponentialHeightFogComponent;
class UPostProcessComponent;

/** Sun, sky atmosphere, real-time sky light, volumetric clouds and fog, unbound post process. All Movable (Lumen). */
UCLASS()
class IPVERSEGAME_API AIpverseEnvironment : public AActor
{
	GENERATED_BODY()

public:
	AIpverseEnvironment();

	/** Arena: neon dusk, dense volumetric fog, strong bloom. Valley: golden-hour day, light haze. */
	void Configure(bool bArena, const FLinearColor& Accent);

	UPROPERTY(VisibleAnywhere) TObjectPtr<UDirectionalLightComponent> Sun;
	UPROPERTY(VisibleAnywhere) TObjectPtr<USkyAtmosphereComponent> Atmosphere;
	UPROPERTY(VisibleAnywhere) TObjectPtr<USkyLightComponent> SkyLight;
	UPROPERTY(VisibleAnywhere) TObjectPtr<UVolumetricCloudComponent> Clouds;
	UPROPERTY(VisibleAnywhere) TObjectPtr<UExponentialHeightFogComponent> Fog;
	UPROPERTY(VisibleAnywhere) TObjectPtr<UPostProcessComponent> Post;
};

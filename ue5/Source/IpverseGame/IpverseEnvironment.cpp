#include "IpverseEnvironment.h"

#include "Components/DirectionalLightComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/VolumetricCloudComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/PostProcessComponent.h"
#include "Materials/MaterialInterface.h"

AIpverseEnvironment::AIpverseEnvironment()
{
	PrimaryActorTick.bCanEverTick = false;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	RootComponent->SetMobility(EComponentMobility::Movable);

	Sun = CreateDefaultSubobject<UDirectionalLightComponent>(TEXT("Sun"));
	Sun->SetupAttachment(RootComponent);
	Sun->SetMobility(EComponentMobility::Movable);
	Sun->bAtmosphereSunLight = true;
	Sun->LightSourceAngle = 1.2f; // soft contact shadows

	Atmosphere = CreateDefaultSubobject<USkyAtmosphereComponent>(TEXT("Atmosphere"));
	Atmosphere->SetupAttachment(RootComponent);

	SkyLight = CreateDefaultSubobject<USkyLightComponent>(TEXT("SkyLight"));
	SkyLight->SetupAttachment(RootComponent);
	SkyLight->SetMobility(EComponentMobility::Movable);
	SkyLight->SourceType = ESkyLightSourceType::SLS_CapturedScene;
	SkyLight->bRealTimeCapture = true; // captures atmosphere + clouds every frame
	SkyLight->bLowerHemisphereIsBlack = false;

	Clouds = CreateDefaultSubobject<UVolumetricCloudComponent>(TEXT("Clouds"));
	Clouds->SetupAttachment(RootComponent);

	Fog = CreateDefaultSubobject<UExponentialHeightFogComponent>(TEXT("Fog"));
	Fog->SetupAttachment(RootComponent);
	Fog->SetMobility(EComponentMobility::Movable);

	Post = CreateDefaultSubobject<UPostProcessComponent>(TEXT("Post"));
	Post->SetupAttachment(RootComponent);
	Post->bUnbound = true;
}

void AIpverseEnvironment::Configure(bool bArena, const FLinearColor& Accent)
{
	FPostProcessSettings& S = Post->Settings;
	S.bOverride_DynamicGlobalIlluminationMethod = true;
	S.DynamicGlobalIlluminationMethod = EDynamicGlobalIlluminationMethod::Lumen;
	S.bOverride_ReflectionMethod = true;
	S.ReflectionMethod = EReflectionMethod::Lumen;
	S.bOverride_BloomIntensity = true;
	S.bOverride_AutoExposureBias = true;
	S.bOverride_VignetteIntensity = true;
	S.bOverride_ColorSaturation = true;

	if (bArena)
	{
		// Neon dusk: the low magenta sun rim-lights the fog; emissive floor and pillars do the rest via Lumen.
		Sun->SetWorldRotation(FRotator(-7.f, 205.f, 0.f));
		Sun->SetIntensity(2.5f);
		Sun->SetLightColor(FLinearColor(1.f, 0.55f, 0.62f));
		SkyLight->SetIntensity(0.55f);
		Fog->SetFogDensity(0.035f);
		Fog->SetFogHeightFalloff(0.25f);
		Fog->SetVolumetricFog(true);
		Fog->SetVolumetricFogExtinctionScale(1.4f);
		S.BloomIntensity = 1.4f;
		S.AutoExposureBias = 0.8f;
		S.VignetteIntensity = 0.45f;
		S.ColorSaturation = FVector4(1.12f, 1.12f, 1.12f, 1.f);
	}
	else
	{
		Sun->SetWorldRotation(FRotator(-24.f, 35.f, 0.f)); // golden hour
		Sun->SetIntensity(9.f);
		Sun->SetLightColor(FLinearColor(1.f, 0.9f, 0.78f));
		SkyLight->SetIntensity(1.f);
		Fog->SetFogDensity(0.012f);
		Fog->SetFogHeightFalloff(0.08f);
		Fog->SetVolumetricFog(true);
		Fog->SetVolumetricFogExtinctionScale(0.6f);
		S.BloomIntensity = 0.55f;
		S.AutoExposureBias = 0.2f;
		S.VignetteIntensity = 0.3f;
		S.ColorSaturation = FVector4(1.05f, 1.05f, 1.05f, 1.f);
	}
	if (UMaterialInterface* CloudMat = LoadObject<UMaterialInterface>(nullptr,
		TEXT("/Engine/EngineSky/VolumetricClouds/m_SimpleVolumetricCloud_Inst.m_SimpleVolumetricCloud_Inst")))
	{
		Clouds->SetMaterial(CloudMat); // explicit: the component default is not referenced by any cooked asset
	}
	SkyLight->RecaptureSky();
}

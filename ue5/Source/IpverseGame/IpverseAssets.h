#pragma once

#include "CoreMinimal.h"

class AActor;
class UStaticMesh;
class UMaterialInterface;
class UMaterialInstanceDynamic;
class UStaticMeshComponent;

/** Engine basic shapes and the materials ue5/Scripts/build_levels.py creates, with safe fallbacks. */
namespace IpverseAssets
{
	enum class EShape : uint8 { Cube, Sphere, Cylinder, Cone, Plane };

	// Water surface height in the valley; M_Terrain/terrain colors and spawns use the same number.
	constexpr float ValleyWaterZ = -150.f;

	UStaticMesh* Shape(EShape InShape);

	/** /Game/Ipverse/Materials/<Name>; BasicShapeMaterial if the asset is missing. */
	UMaterialInterface* Material(const TCHAR* Name);

	/** MID of <Name> with "Tint" (and "Glow" when > 0) set. */
	UMaterialInstanceDynamic* Tinted(UObject* Outer, const TCHAR* Name, const FLinearColor& Tint, float Glow = 0.f);

	/**
	 * Puts Mesh (pivot at the feet, from glTFRuntime PivotPosition=Bottom) on Body, scaled to TargetHeight cm,
	 * centred in XY, feet at FootZ, turned by YawOffset. Returns the applied scale.
	 */
	float FitMesh(UStaticMeshComponent* Body, UStaticMesh* Mesh, float TargetHeight, float FootZ, float YawOffset);

	/** Adds a registered static mesh component to Owner (attached to its root). */
	UStaticMeshComponent* AddMesh(AActor* Owner, UStaticMesh* Mesh, UMaterialInterface* Mat, const FTransform& Relative,
		bool bCollision = true);
}

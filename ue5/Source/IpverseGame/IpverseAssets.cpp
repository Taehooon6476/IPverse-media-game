#include "IpverseAssets.h"
#include "IpverseGame.h"

#include "Engine/StaticMesh.h"
#include "Components/StaticMeshComponent.h"
#include "GameFramework/Actor.h"
#include "Materials/MaterialInterface.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "UObject/UObjectGlobals.h"

namespace IpverseAssets
{
	UStaticMesh* Shape(EShape InShape)
	{
		const TCHAR* Path = TEXT("/Engine/BasicShapes/Cube.Cube");
		switch (InShape)
		{
		case EShape::Sphere:   Path = TEXT("/Engine/BasicShapes/Sphere.Sphere"); break;
		case EShape::Cylinder: Path = TEXT("/Engine/BasicShapes/Cylinder.Cylinder"); break;
		case EShape::Cone:     Path = TEXT("/Engine/BasicShapes/Cone.Cone"); break;
		case EShape::Plane:    Path = TEXT("/Engine/BasicShapes/Plane.Plane"); break;
		default: break;
		}
		return LoadObject<UStaticMesh>(nullptr, Path);
	}

	UMaterialInterface* Material(const TCHAR* Name)
	{
		const FString Path = FString::Printf(TEXT("/Game/Ipverse/Materials/%s.%s"), Name, Name);
		if (UMaterialInterface* Found = LoadObject<UMaterialInterface>(nullptr, *Path))
		{
			return Found;
		}
		UE_LOG(LogIpverse, Warning, TEXT("Material %s missing, using BasicShapeMaterial"), Name);
		return LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	}

	UMaterialInstanceDynamic* Tinted(UObject* Outer, const TCHAR* Name, const FLinearColor& Tint, float Glow)
	{
		UMaterialInstanceDynamic* Mid = UMaterialInstanceDynamic::Create(Material(Name), Outer);
		if (Mid)
		{
			Mid->SetVectorParameterValue(TEXT("Tint"), Tint);
			Mid->SetVectorParameterValue(TEXT("Color"), Tint); // BasicShapeMaterial fallback parameter
			if (Glow > 0.f)
			{
				Mid->SetScalarParameterValue(TEXT("Glow"), Glow);
			}
		}
		return Mid;
	}

	float FitMesh(UStaticMeshComponent* Body, UStaticMesh* Mesh, float TargetHeight, float FootZ, float YawOffset)
	{
		Body->SetStaticMesh(Mesh);
		const FBoxSphereBounds B = Mesh->GetBounds();
		const float Height = FMath::Max(B.BoxExtent.Z * 2.f, 1.f);
		const float Scale = FMath::Clamp(TargetHeight / Height, 0.01f, 1000.f);
		const FRotator Yaw(0.f, YawOffset, 0.f);
		const FVector Centre = Yaw.RotateVector(FVector(-B.Origin.X, -B.Origin.Y, 0.f) * Scale);
		const float Bottom = (B.Origin.Z - B.BoxExtent.Z) * Scale; // ~0 with PivotPosition=Bottom
		Body->SetRelativeTransform(FTransform(Yaw, Centre + FVector(0, 0, FootZ - Bottom), FVector(Scale)));
		return Scale;
	}

	UStaticMeshComponent* AddMesh(AActor* Owner, UStaticMesh* Mesh, UMaterialInterface* Mat, const FTransform& Relative, bool bCollision)
	{
		UStaticMeshComponent* C = NewObject<UStaticMeshComponent>(Owner);
		C->SetMobility(EComponentMobility::Movable);
		C->SetStaticMesh(Mesh);
		if (Mat)
		{
			for (int32 i = 0; i < FMath::Max(1, C->GetNumMaterials()); ++i) { C->SetMaterial(i, Mat); }
		}
		C->SetCollisionEnabled(bCollision ? ECollisionEnabled::QueryAndPhysics : ECollisionEnabled::NoCollision);
		if (bCollision)
		{
			C->SetCollisionProfileName(TEXT("BlockAll"));
		}
		C->SetupAttachment(Owner->GetRootComponent());
		C->SetRelativeTransform(Relative);
		C->RegisterComponent();
		Owner->AddInstanceComponent(C);
		return C;
	}
}

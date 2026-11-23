#include "IpverseLevel.h"
#include "IpverseAssets.h"
#include "IpverseGame.h"

#include "Components/HierarchicalInstancedStaticMeshComponent.h"
#include "Components/PointLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "ProceduralMeshComponent.h"
#include "KismetProceduralMeshLibrary.h"

using namespace IpverseAssets;

namespace
{
	float Smooth(float A, float B, float X)
	{
		const float T = FMath::Clamp((X - A) / (B - A), 0.f, 1.f);
		return T * T * (3.f - 2.f * T);
	}

	float Noise(float X, float Y, float Scale, float Off)
	{
		return FMath::PerlinNoise2D(FVector2D(X / Scale + Off, Y / Scale - Off * 0.7f));
	}
}

AIpverseLevel::AIpverseLevel()
{
	PrimaryActorTick.bCanEverTick = false;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	RootComponent->SetMobility(EComponentMobility::Movable);
}

UHierarchicalInstancedStaticMeshComponent* AIpverseLevel::AddInstances(UStaticMesh* Mesh, UMaterialInterface* Mat, bool bCollision)
{
	UHierarchicalInstancedStaticMeshComponent* H = NewObject<UHierarchicalInstancedStaticMeshComponent>(this);
	H->SetMobility(EComponentMobility::Movable);
	H->SetStaticMesh(Mesh);
	H->SetMaterial(0, Mat);
	H->SetCollisionEnabled(bCollision ? ECollisionEnabled::QueryAndPhysics : ECollisionEnabled::NoCollision);
	if (bCollision)
	{
		H->SetCollisionProfileName(TEXT("BlockAll"));
	}
	H->SetupAttachment(RootComponent);
	H->RegisterComponent();
	AddInstanceComponent(H);
	return H;
}

// ── arena ───────────────────────────────────────────────────────────────────────

void AIpverseLevel::BuildArena(int32 Seed, const FLinearColor& Accent)
{
	bArena = true;
	LevelSeed = Seed;
	FRandomStream Rng(Seed);
	const FLinearColor Hot = FLinearColor(1.f - Accent.R * 0.6f, 0.25f + Accent.B * 0.3f, 0.9f); // complementary neon
	UStaticMesh* Cube = Shape(EShape::Cube);
	UStaticMesh* Cylinder = Shape(EShape::Cylinder);
	const float S = ArenaHalf * 2.f / 100.f;

	UMaterialInstanceDynamic* Grid = Tinted(this, TEXT("M_NeonGrid"), Accent, 6.f);
	AddMesh(this, Cube, Grid, FTransform(FRotator::ZeroRotator, FVector(0, 0, -25.f), FVector(S, S, 0.5f)));

	UMaterialInstanceDynamic* Dark = Tinted(this, TEXT("M_Surface"), FLinearColor(0.035f, 0.04f, 0.055f));
	Dark->SetScalarParameterValue(TEXT("Metallic"), 0.85f);
	Dark->SetScalarParameterValue(TEXT("Roughness"), 0.28f);
	UMaterialInstanceDynamic* Edge = Tinted(this, TEXT("M_Glow"), Accent, 40.f);
	UMaterialInstanceDynamic* EdgeHot = Tinted(this, TEXT("M_Glow"), Hot, 30.f);

	// perimeter walls with two neon strips
	for (int32 Side = 0; Side < 4; ++Side)
	{
		const FRotator Rot(0.f, Side * 90.f, 0.f);
		const FVector Out = Rot.RotateVector(FVector(ArenaHalf + 50.f, 0, 0));
		AddMesh(this, Cube, Dark, FTransform(Rot, Out + FVector(0, 0, 200.f), FVector(1.f, S + 2.f, 4.f)));
		AddMesh(this, Cube, Edge, FTransform(Rot, Out + FVector(-52.f, 0, 395.f), FVector(0.06f, S + 2.f, 0.1f)), false);
		AddMesh(this, Cube, EdgeHot, FTransform(Rot, Out + FVector(-52.f, 0, 30.f), FVector(0.04f, S + 2.f, 0.06f)), false);
	}

	// cover blocks with glowing top edges
	for (int32 i = 0; i < 24; ++i)
	{
		FVector P;
		do
		{
			P = FVector(Rng.FRandRange(-0.82f, 0.82f) * ArenaHalf, Rng.FRandRange(-0.82f, 0.82f) * ArenaHalf, 0);
		} while (P.Size2D() < 900.f);
		const FVector Size(Rng.FRandRange(1.6f, 4.2f), Rng.FRandRange(0.6f, 1.2f), Rng.FRandRange(1.1f, 2.2f));
		const FRotator Rot(0.f, Rng.RandRange(0, 3) * 45.f, 0.f);
		AddMesh(this, Cube, Dark, FTransform(Rot, P + FVector(0, 0, Size.Z * 50.f), Size));
		AddMesh(this, Cube, i % 3 ? Edge : EdgeHot,
			FTransform(Rot, P + FVector(0, 0, Size.Z * 100.f + 2.f), FVector(Size.X, 0.05f, 0.04f)), false);
		const float R = FMath::Max(Size.X, Size.Y) * 50.f + 80.f;
		Blockers.Add(FBox2D(FVector2D(P.X - R, P.Y - R), FVector2D(P.X + R, P.Y + R)));
	}

	// light pillars on a ring, each with glowing bands and a coloured point light at the base
	for (int32 i = 0; i < 8; ++i)
	{
		const FVector P = FRotator(0.f, i * 45.f + 22.5f, 0.f).RotateVector(FVector(ArenaHalf * 0.72f, 0, 0));
		AddMesh(this, Cylinder, Dark, FTransform(FRotator::ZeroRotator, P + FVector(0, 0, 700.f), FVector(1.4f, 1.4f, 14.f)));
		for (int32 Band = 0; Band < 4; ++Band)
		{
			AddMesh(this, Cylinder, Band % 2 ? EdgeHot : Edge,
				FTransform(FRotator::ZeroRotator, P + FVector(0, 0, 250.f + Band * 320.f), FVector(1.46f, 1.46f, 0.08f)), false);
		}
		UPointLightComponent* L = NewObject<UPointLightComponent>(this);
		L->SetMobility(EComponentMobility::Movable);
		L->SetupAttachment(RootComponent);
		L->SetRelativeLocation(P + FVector(0, 0, 150.f));
		L->SetLightColor(i % 2 ? Hot : Accent);
		L->SetIntensity(60000.f);
		L->SetAttenuationRadius(2600.f);
		L->SetCastShadows(false);
		L->RegisterComponent();
		AddInstanceComponent(L);
		const float R = 220.f;
		Blockers.Add(FBox2D(FVector2D(P.X - R, P.Y - R), FVector2D(P.X + R, P.Y + R)));
	}

	// centre ring
	AddMesh(this, Cylinder, Edge, FTransform(FRotator::ZeroRotator, FVector(0, 0, 1.f), FVector(6.f, 6.f, 0.01f)), false);
	AddMesh(this, Cylinder, Dark, FTransform(FRotator::ZeroRotator, FVector(0, 0, 2.f), FVector(5.7f, 5.7f, 0.01f)), false);

	// skyline beyond the walls: dark towers with lit window bands
	UHierarchicalInstancedStaticMeshComponent* Towers = AddInstances(Cube, Dark, false);
	UHierarchicalInstancedStaticMeshComponent* Windows = AddInstances(Cube, Tinted(this, TEXT("M_Glow"), Accent * 0.6f + Hot * 0.4f, 8.f), false);
	for (int32 i = 0; i < 70; ++i)
	{
		const float A = Rng.FRandRange(0.f, 360.f);
		const float D = Rng.FRandRange(7000.f, 16000.f);
		const FVector P = FRotator(0.f, A, 0.f).RotateVector(FVector(D, 0, 0));
		const FVector Size(Rng.FRandRange(6.f, 16.f), Rng.FRandRange(6.f, 16.f), Rng.FRandRange(20.f, 80.f));
		Towers->AddInstance(FTransform(FRotator(0.f, A, 0.f), P + FVector(0, 0, Size.Z * 50.f), Size));
		for (int32 Band = 0; Band < 5; ++Band)
		{
			const float Z = Rng.FRandRange(0.15f, 0.95f) * Size.Z * 100.f;
			Windows->AddInstance(FTransform(FRotator(0.f, A, 0.f), P + FVector(0, 0, Z), FVector(Size.X * 1.01f, Size.Y * 1.01f, 0.12f)));
		}
	}
}

// ── valley ──────────────────────────────────────────────────────────────────────

float AIpverseLevel::ValleyHeight(float X, float Y) const
{
	const float Off = (LevelSeed % 997) * 0.173f;
	const float R = FVector2D(X, Y).Size() / ValleyHalf;
	const float Rim = Smooth(0.42f, 1.0f, R) * (2400.f + 900.f * Noise(X, Y, 7000.f, Off + 3.f));
	const float Hills = Noise(X, Y, 6000.f, Off) * 260.f + Noise(X, Y, 1900.f, Off + 11.f) * 90.f + Noise(X, Y, 520.f, Off + 5.f) * 18.f;
	const FVector2D Lake(5200.f, -3800.f);
	const float LakeD = (FVector2D(X, Y) - Lake).Size();
	const float Basin = -420.f * FMath::Exp(-FMath::Square(LakeD / 3200.f));
	// hills fade out towards the centre so the spawn meadow stays gentle
	return Hills * (0.35f + 0.65f * Smooth(0.08f, 0.3f, R)) + Rim + Basin - 40.f;
}

float AIpverseLevel::Slope(float X, float Y) const
{
	const float E = 200.f;
	const FVector N = FVector(ValleyHeight(X - E, Y) - ValleyHeight(X + E, Y), ValleyHeight(X, Y - E) - ValleyHeight(X, Y + E), 2.f * E).GetSafeNormal();
	return 1.f - N.Z;
}

void AIpverseLevel::BuildValley(int32 Seed)
{
	bArena = false;
	LevelSeed = Seed;
	FRandomStream Rng(Seed);

	// terrain: welded grid from the engine helper (correct winding), heights + normals + biome colours from noise
	const int32 N = 181;
	const float Spacing = ValleyHalf * 2.f / (N - 1);
	TArray<int32> Tris;
	TArray<FVector> Verts;
	TArray<FVector2D> UVs;
	UKismetProceduralMeshLibrary::CreateGridMeshWelded(N, N, Tris, Verts, UVs, Spacing);
	TArray<FVector> Normals;
	TArray<FLinearColor> Colors;
	Normals.Reserve(Verts.Num());
	Colors.Reserve(Verts.Num());
	const float Off = (Seed % 997) * 0.173f;
	for (FVector& V : Verts)
	{
		V.X -= ValleyHalf;
		V.Y -= ValleyHalf;
		V.Z = ValleyHeight(V.X, V.Y);
		const float E = Spacing * 0.5f;
		Normals.Add(FVector(ValleyHeight(V.X - E, V.Y) - ValleyHeight(V.X + E, V.Y),
			ValleyHeight(V.X, V.Y - E) - ValleyHeight(V.X, V.Y + E), 2.f * E).GetSafeNormal());
		const float SlopeV = 1.f - Normals.Last().Z;
		const float Patch = 0.5f + 0.5f * Noise(V.X, V.Y, 1400.f, Off + 21.f);
		const float Dry = Smooth(0.55f, 0.85f, 0.5f + 0.5f * Noise(V.X, V.Y, 4200.f, Off + 7.f));
		FLinearColor C = FMath::Lerp(FLinearColor(0.07f, 0.16f, 0.035f), FLinearColor(0.16f, 0.25f, 0.05f), Patch);
		C = FMath::Lerp(C, FLinearColor(0.30f, 0.27f, 0.13f), Dry * 0.7f);
		C = FMath::Lerp(FLinearColor(0.46f, 0.40f, 0.27f), C, Smooth(IpverseAssets::ValleyWaterZ + 20.f, IpverseAssets::ValleyWaterZ + 140.f, V.Z)); // shore sand
		C = FMath::Lerp(C, FLinearColor(0.20f, 0.19f, 0.18f), Smooth(0.18f, 0.38f, SlopeV)); // rock on steep slopes
		C = FMath::Lerp(C, FLinearColor(0.82f, 0.85f, 0.9f), Smooth(1900.f, 2400.f, V.Z) * (1.f - Smooth(0.35f, 0.55f, SlopeV)));
		Colors.Add(C);
	}
	for (FVector2D& UV : UVs) { UV *= 40.f; }

	Terrain = NewObject<UProceduralMeshComponent>(this, TEXT("Terrain"));
	Terrain->SetupAttachment(RootComponent);
	Terrain->bUseComplexAsSimpleCollision = true;
	Terrain->RegisterComponent();
	AddInstanceComponent(Terrain);
	Terrain->CreateMeshSection_LinearColor(0, Verts, Tris, Normals, UVs, Colors, TArray<FProcMeshTangent>(), true);
	Terrain->SetMaterial(0, Material(TEXT("M_Terrain")));
	Terrain->SetCollisionProfileName(TEXT("BlockAll"));

	// water: thin walkable slab, top at the water line
	UStaticMesh* Cube = Shape(EShape::Cube);
	AddMesh(this, Cube, Material(TEXT("M_Water")),
		FTransform(FRotator::ZeroRotator, FVector(0, 0, IpverseAssets::ValleyWaterZ - 5.f), FVector(ValleyHalf * 0.02f, ValleyHalf * 0.02f, 0.1f)));

	// vegetation and rocks (instanced; PerInstanceRandom varies the tint in M_Surface)
	UMaterialInstanceDynamic* Bark = Tinted(this, TEXT("M_Surface"), FLinearColor(0.16f, 0.09f, 0.05f));
	UMaterialInstanceDynamic* Needles = Tinted(this, TEXT("M_Surface"), FLinearColor(0.05f, 0.14f, 0.06f));
	UMaterialInstanceDynamic* Leaves = Tinted(this, TEXT("M_Surface"), FLinearColor(0.16f, 0.26f, 0.05f));
	UMaterialInstanceDynamic* Stone = Tinted(this, TEXT("M_Surface"), FLinearColor(0.32f, 0.31f, 0.3f));
	UMaterialInstanceDynamic* Grass = Tinted(this, TEXT("M_Surface"), FLinearColor(0.14f, 0.24f, 0.05f));
	UMaterialInstanceDynamic* Bloom = Tinted(this, TEXT("M_Glow"), FLinearColor(1.f, 0.75f, 0.35f), 1.2f);
	Needles->SetScalarParameterValue(TEXT("Roughness"), 0.85f);
	Leaves->SetScalarParameterValue(TEXT("Roughness"), 0.8f);

	UHierarchicalInstancedStaticMeshComponent* Trunks = AddInstances(Shape(EShape::Cylinder), Bark, true);
	UHierarchicalInstancedStaticMeshComponent* Cones = AddInstances(Shape(EShape::Cone), Needles, false);
	UHierarchicalInstancedStaticMeshComponent* Crowns = AddInstances(Shape(EShape::Sphere), Leaves, false);
	UHierarchicalInstancedStaticMeshComponent* Rocks = AddInstances(Shape(EShape::Sphere), Stone, true);
	UHierarchicalInstancedStaticMeshComponent* Tufts = AddInstances(Shape(EShape::Cone), Grass, false);
	UHierarchicalInstancedStaticMeshComponent* Flowers = AddInstances(Shape(EShape::Sphere), Bloom, false);
	Tufts->SetCastShadow(false);
	Tufts->SetCullDistances(3500, 6000);
	Flowers->SetCastShadow(false);
	Flowers->SetCullDistances(3000, 5000);

	auto Ok = [this](float X, float Y, float ClearRadius) {
		const float Z = ValleyHeight(X, Y);
		return Z > IpverseAssets::ValleyWaterZ + 90.f && Z < 1900.f && Slope(X, Y) < 0.3f
			&& FVector2D(X, Y).Size() > ClearRadius;
	};

	for (int32 i = 0, Placed = 0; i < 9000 && Placed < 1500; ++i)
	{
		const float X = Rng.FRandRange(-0.95f, 0.95f) * ValleyHalf, Y = Rng.FRandRange(-0.95f, 0.95f) * ValleyHalf;
		const bool bForest = Noise(X, Y, 3000.f, Off + 40.f) > -0.1f;
		if (!Ok(X, Y, 2600.f) || (!bForest && Rng.FRand() < 0.85f))
		{
			continue;
		}
		++Placed;
		const float Z = ValleyHeight(X, Y) - 20.f;
		const float K = Rng.FRandRange(0.8f, 1.7f);
		const FRotator Yaw(0.f, Rng.FRandRange(0.f, 360.f), 0.f);
		if (Rng.FRand() < 0.7f) // conifer: trunk + three stacked cones
		{
			Trunks->AddInstance(FTransform(Yaw, FVector(X, Y, Z + 150.f * K), FVector(0.32f, 0.32f, 3.f) * K));
			for (int32 Tier = 0; Tier < 3; ++Tier)
			{
				const float W = (3.4f - Tier * 0.8f) * K;
				Cones->AddInstance(FTransform(Yaw, FVector(X, Y, Z + (230.f + Tier * 150.f) * K), FVector(W, W, 2.4f * K)));
			}
		}
		else // broadleaf: trunk + clustered crowns
		{
			Trunks->AddInstance(FTransform(Yaw, FVector(X, Y, Z + 130.f * K), FVector(0.4f, 0.4f, 2.6f) * K));
			for (int32 Blob = 0; Blob < 3; ++Blob)
			{
				const FVector O = Yaw.RotateVector(FVector(Blob == 0 ? 0.f : 80.f, Blob == 2 ? 90.f : -60.f, 0.f)) * K;
				const float W = Rng.FRandRange(2.4f, 3.4f) * K;
				Crowns->AddInstance(FTransform(Yaw, FVector(X, Y, Z + (330.f + Blob * 40.f) * K) + O, FVector(W, W, W * 0.85f)));
			}
		}
	}

	for (int32 i = 0, Placed = 0; i < 4000 && Placed < 320; ++i)
	{
		const float X = Rng.FRandRange(-0.97f, 0.97f) * ValleyHalf, Y = Rng.FRandRange(-0.97f, 0.97f) * ValleyHalf;
		const float Z = ValleyHeight(X, Y);
		if (Z < IpverseAssets::ValleyWaterZ - 40.f || FVector2D(X, Y).Size() < 1800.f)
		{
			continue;
		}
		++Placed;
		const FVector Size(Rng.FRandRange(1.f, 5.f), Rng.FRandRange(0.8f, 3.5f), Rng.FRandRange(0.6f, 2.2f));
		Rocks->AddInstance(FTransform(FRotator(Rng.FRandRange(-20.f, 20.f), Rng.FRandRange(0.f, 360.f), Rng.FRandRange(-20.f, 20.f)),
			FVector(X, Y, Z + Size.Z * 15.f), Size));
	}

	for (int32 i = 0, Placed = 0; i < 30000 && Placed < 9000; ++i)
	{
		const float X = Rng.FRandRange(-0.6f, 0.6f) * ValleyHalf, Y = Rng.FRandRange(-0.6f, 0.6f) * ValleyHalf;
		if (!Ok(X, Y, 0.f))
		{
			continue;
		}
		++Placed;
		const float Z = ValleyHeight(X, Y);
		if (Rng.FRand() < 0.08f)
		{
			Flowers->AddInstance(FTransform(FRotator::ZeroRotator, FVector(X, Y, Z + 25.f), FVector(0.09f)));
		}
		else
		{
			const float H = Rng.FRandRange(0.25f, 0.55f);
			Tufts->AddInstance(FTransform(FRotator(Rng.FRandRange(-12.f, 12.f), Rng.FRandRange(0.f, 360.f), 0.f),
				FVector(X, Y, Z + H * 40.f), FVector(0.14f, 0.14f, H)));
		}
	}
	UE_LOG(LogIpverse, Log, TEXT("Valley built: %d terrain verts"), Verts.Num());
}

// ── queries ─────────────────────────────────────────────────────────────────────

float AIpverseLevel::GroundZ(float X, float Y) const
{
	return bArena ? 0.f : FMath::Max(ValleyHeight(X, Y), IpverseAssets::ValleyWaterZ);
}

FVector AIpverseLevel::RandomSpot(FRandomStream& Rng, float MinRadius, float MaxRadius) const
{
	for (int32 Try = 0; Try < 200; ++Try)
	{
		const float A = Rng.FRandRange(0.f, 2.f * PI);
		const float D = Rng.FRandRange(MinRadius, MaxRadius);
		const float X = FMath::Cos(A) * D, Y = FMath::Sin(A) * D;
		bool bFree = true;
		for (const FBox2D& B : Blockers)
		{
			if (B.IsInside(FVector2D(X, Y))) { bFree = false; break; }
		}
		if (!bFree)
		{
			continue;
		}
		if (!bArena && (ValleyHeight(X, Y) < IpverseAssets::ValleyWaterZ + 60.f || Slope(X, Y) > 0.25f))
		{
			continue;
		}
		return FVector(X, Y, GroundZ(X, Y));
	}
	return FVector(MinRadius, 0.f, GroundZ(MinRadius, 0.f));
}

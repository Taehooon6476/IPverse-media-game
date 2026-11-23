#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "IpverseLevel.generated.h"

class UStaticMesh;
class UMaterialInterface;
class UProceduralMeshComponent;
class UHierarchicalInstancedStaticMeshComponent;

/**
 * Procedural template geometry, data-driven from the GameSpec (seed, accent); no per-game cooking.
 * Arena: 80 m neon grid floor, glowing perimeter, cover blocks, light pillars.
 * Valley: 360 m terrain mesh (mountain rim, lake), water, instanced trees, rocks and grass.
 */
UCLASS()
class IPVERSEGAME_API AIpverseLevel : public AActor
{
	GENERATED_BODY()

public:
	AIpverseLevel();

	void BuildArena(int32 Seed, const FLinearColor& Accent);
	void BuildValley(int32 Seed);

	/** Ground height under (X, Y), in cm. */
	float GroundZ(float X, float Y) const;

	/** A walkable point at least MinRadius from the origin, away from water and cover. */
	FVector RandomSpot(FRandomStream& Rng, float MinRadius, float MaxRadius) const;

	bool IsArena() const { return bArena; }
	float PlayRadius() const { return bArena ? ArenaHalf - 300.f : 9000.f; }

	static constexpr float ArenaHalf = 4000.f;
	static constexpr float ValleyHalf = 18000.f;

private:
	float ValleyHeight(float X, float Y) const;
	float Slope(float X, float Y) const;
	UHierarchicalInstancedStaticMeshComponent* AddInstances(UStaticMesh* Mesh, UMaterialInterface* Mat, bool bCollision);

	bool bArena = true;
	int32 LevelSeed = 1234;
	TArray<FBox2D> Blockers; // cover footprints (arena), so spawns avoid them

	UPROPERTY() TObjectPtr<UProceduralMeshComponent> Terrain;
};

// UE 5.6 + glTFRuntime 20260826 (cef7be2).
#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "Interfaces/IHttpRequest.h"
#include "IpverseSpecSubsystem.generated.h"

class UStaticMesh;
class FJsonObject;

UENUM(BlueprintType)
enum class EIpverseTemplate : uint8
{
	Arena,  // sf-shooter, sf-survival: neon shooter arena
	Valley, // rpg-explore, rpg-quest: open valley with NPCs and a quest
};

UENUM(BlueprintType)
enum class EIpverseLoadState : uint8 { Idle, Loading, Ready, Failed };

/** One entity the templates spawn: GameSpec fields + the IP's runtime mesh (null = procedural placeholder). */
USTRUCT(BlueprintType)
struct FIpverseEntity
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly) FString IpId;
	UPROPERTY(BlueprintReadOnly) FString Role;   // player | enemy | prop | npc
	UPROPERTY(BlueprintReadOnly) FString Name;
	UPROPERTY(BlueprintReadOnly) FString Effect; // props: heal | score | shield | key
	UPROPERTY(BlueprintReadOnly) FString Shape;  // enemies: triangle | circle | square
	UPROPERTY(BlueprintReadOnly) FLinearColor Color = FLinearColor::White;
	UPROPERTY(BlueprintReadOnly) int32 Speed = 2;
	UPROPERTY(BlueprintReadOnly) int32 Hp = 1;
	UPROPERTY(BlueprintReadOnly) float YawOffset = 0.f; // degrees, from the manifest (model forward axis fix)
	UPROPERTY(BlueprintReadOnly) TObjectPtr<UStaticMesh> Mesh = nullptr;
};

DECLARE_MULTICAST_DELEGATE_OneParam(FIpverseSpecLoaded, bool /*bSuccess*/);

/**
 * Launch contract (docs/ue5/design.md): -IpverseSpecUrl=<https url> (wins) or env IPVERSE_SPEC_URL.
 * Downloads manifest v1 and every GLB it lists, builds static meshes with glTFRuntime (pivot at the feet).
 */
UCLASS()
class IPVERSEGAME_API UIpverseSpecSubsystem : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;

	/** Starts loading once; later calls are no-ops. */
	void Load();

	FIpverseSpecLoaded OnLoaded;

	EIpverseLoadState GetState() const { return State; }
	FString GetFailure() const { return Failure; }
	EIpverseTemplate GetTemplate() const { return Genre.StartsWith(TEXT("rpg-")) ? EIpverseTemplate::Valley : EIpverseTemplate::Arena; }

	FString Genre = TEXT("sf-shooter");
	FString Title;
	FString ObjectiveType = TEXT("kills");
	int32 ObjectiveTarget = 10;
	FString Difficulty = TEXT("normal");
	FString QuestTitle;
	int32 Seed = 1234;
	FLinearColor Accent = FLinearColor(0.2f, 0.8f, 1.f);
	TArray<FString> Dialogue;

	/** Player first, then enemies, props, npcs (spec order). */
	UPROPERTY() TArray<FIpverseEntity> Entities; // UPROPERTY keeps the runtime meshes alive across level reloads

	const FIpverseEntity* Player() const;
	TArray<FIpverseEntity> ByRole(const FString& Role) const;

private:
	FString ResolveSpecUrl() const;
	void OnManifest(FHttpRequestPtr Req, FHttpResponsePtr Resp, bool bOk);
	bool ParseManifest(const FString& Body, TMap<FString, FString>& OutGlbUrls);
	void OnGlb(FHttpRequestPtr Req, FHttpResponsePtr Resp, bool bOk, FString IpId);
	void Finish(bool bSuccess, const FString& Why = FString());

	EIpverseLoadState State = EIpverseLoadState::Idle;
	FString Failure;
	int32 PendingGlbs = 0;
	TMap<FString, float> Yaws;
};

#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "IpverseHud.generated.h"

/** Everything the HUD shows; the GameMode writes it every frame. */
struct FIpverseHudState
{
	bool bLoading = true;
	FString LoadingText = TEXT("게임 준비 중…");
	FString Title;
	FString Objective;
	int32 Score = 0;
	float Health01 = 1.f;
	bool bShield = false;
	float Hurt = 0.f;
	bool bCrosshair = false;
	FString Prompt;
	FString DialogueName;
	FString DialogueText;
	FString Banner;
	FString BannerSub;
	FString Help;
	FLinearColor Accent = FLinearColor(0.3f, 0.85f, 1.f);
};

/** Slate overlay with a Korean font (Content/Fonts/NanumGothicBold.ttf, staged as a loose file). */
UCLASS()
class IPVERSEGAME_API AIpverseHud : public AHUD
{
	GENERATED_BODY()

public:
	FIpverseHudState State;

protected:
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type Reason) override;

private:
	TSharedPtr<class SWidget> Root;
};

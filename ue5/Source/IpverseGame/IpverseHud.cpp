#include "IpverseHud.h"
#include "IpverseGame.h"

#include "Engine/GameViewportClient.h"
#include "Engine/World.h"
#include "Fonts/CompositeFont.h"
#include "Fonts/SlateFontInfo.h"
#include "Misc/Paths.h"
#include "Styling/CoreStyle.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Notifications/SProgressBar.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SOverlay.h"
#include "Widgets/Text/STextBlock.h"

namespace
{
	FSlateFontInfo HudFont(int32 Size)
	{
		static TSharedPtr<const FCompositeFont> Composite;
		static bool bTried = false;
		if (!bTried)
		{
			bTried = true;
			const FString Path = FPaths::ProjectContentDir() / TEXT("Fonts/NanumGothicBold.ttf");
			if (FPaths::FileExists(Path))
			{
				Composite = MakeShared<FStandaloneCompositeFont>(NAME_None, Path, EFontHinting::Default, EFontLoadingPolicy::LazyLoad);
			}
			else
			{
				UE_LOG(LogIpverse, Warning, TEXT("Korean font missing at %s"), *Path);
			}
		}
		FSlateFontInfo Font = Composite.IsValid() ? FSlateFontInfo(Composite, Size) : FCoreStyle::GetDefaultFontStyle("Bold", Size);
		Font.OutlineSettings = FFontOutlineSettings(1, FLinearColor(0.f, 0.f, 0.f, 0.8f));
		return Font;
	}

	const FSlateBrush* White()
	{
		return FCoreStyle::Get().GetBrush("GenericWhiteBox");
	}
}

void AIpverseHud::BeginPlay()
{
	Super::BeginPlay();
	UGameViewportClient* Viewport = GetWorld() ? GetWorld()->GetGameViewport() : nullptr;
	if (!Viewport)
	{
		return;
	}
	TWeakObjectPtr<AIpverseHud> Weak(this);
	auto S = [Weak]() -> const FIpverseHudState& {
		static const FIpverseHudState Empty;
		return Weak.IsValid() ? Weak->State : Empty;
	};
	auto Text = [S](TFunction<FString(const FIpverseHudState&)> Get) {
		return TAttribute<FText>::CreateLambda([S, Get]() { return FText::FromString(Get(S())); });
	};
	auto Shown = [S](TFunction<bool(const FIpverseHudState&)> Get) {
		return TAttribute<EVisibility>::CreateLambda([S, Get]() { return Get(S()) ? EVisibility::HitTestInvisible : EVisibility::Collapsed; });
	};
	const FLinearColor Panel(0.f, 0.f, 0.f, 0.55f);

	Root = SNew(SOverlay)
		// hurt vignette
		+ SOverlay::Slot().HAlign(HAlign_Fill).VAlign(VAlign_Fill)
		[
			SNew(SImage).Image(White())
			.ColorAndOpacity(TAttribute<FSlateColor>::CreateLambda([S]() { return FSlateColor(FLinearColor(0.8f, 0.f, 0.05f, 0.35f * S().Hurt)); }))
			.Visibility(Shown([](const FIpverseHudState& H) { return H.Hurt > 0.01f && !H.bLoading; }))
		]
		// objective, top left
		+ SOverlay::Slot().HAlign(HAlign_Left).VAlign(VAlign_Top).Padding(36.f, 28.f)
		[
			SNew(SBorder).BorderImage(White()).BorderBackgroundColor(Panel).Padding(FMargin(18.f, 12.f))
			.Visibility(Shown([](const FIpverseHudState& H) { return !H.bLoading; }))
			[
				SNew(SVerticalBox)
				+ SVerticalBox::Slot().AutoHeight()
				[
					SNew(STextBlock).Font(HudFont(22)).Text(Text([](const FIpverseHudState& H) { return H.Title; }))
					.ColorAndOpacity(TAttribute<FSlateColor>::CreateLambda([S]() { return FSlateColor(S().Accent); }))
				]
				+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 6.f, 0.f, 0.f)
				[
					SNew(STextBlock).Font(HudFont(26)).ColorAndOpacity(FLinearColor::White)
					.Text(Text([](const FIpverseHudState& H) { return H.Objective; }))
				]
			]
		]
		// score, top right
		+ SOverlay::Slot().HAlign(HAlign_Right).VAlign(VAlign_Top).Padding(36.f, 28.f)
		[
			SNew(STextBlock).Font(HudFont(30)).ColorAndOpacity(FLinearColor::White)
			.Text(Text([](const FIpverseHudState& H) { return FString::Printf(TEXT("점수 %d"), H.Score); }))
			.Visibility(Shown([](const FIpverseHudState& H) { return !H.bLoading; }))
		]
		// health, bottom left
		+ SOverlay::Slot().HAlign(HAlign_Left).VAlign(VAlign_Bottom).Padding(36.f, 32.f)
		[
			SNew(SVerticalBox).Visibility(Shown([](const FIpverseHudState& H) { return !H.bLoading; }))
			+ SVerticalBox::Slot().AutoHeight()
			[
				SNew(STextBlock).Font(HudFont(20)).ColorAndOpacity(FLinearColor::White)
				.Text(Text([](const FIpverseHudState& H) { return H.bShield ? TEXT("체력  · 보호막") : TEXT("체력"); }))
			]
			+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 6.f, 0.f, 0.f)
			[
				SNew(SBox).WidthOverride(360.f).HeightOverride(18.f)
				[
					SNew(SProgressBar)
					.Percent(TAttribute<TOptional<float>>::CreateLambda([S]() { return TOptional<float>(S().Health01); }))
					.FillColorAndOpacity(TAttribute<FSlateColor>::CreateLambda([S]() {
						const FIpverseHudState& H = S();
						return FSlateColor(H.bShield ? FLinearColor(0.35f, 0.7f, 1.f) : FMath::Lerp(FLinearColor(1.f, 0.2f, 0.2f), FLinearColor(0.3f, 1.f, 0.5f), H.Health01));
					}))
				]
			]
		]
		// controls help, bottom right
		+ SOverlay::Slot().HAlign(HAlign_Right).VAlign(VAlign_Bottom).Padding(36.f, 32.f)
		[
			SNew(STextBlock).Font(HudFont(17)).ColorAndOpacity(FLinearColor(1.f, 1.f, 1.f, 0.75f))
			.Text(Text([](const FIpverseHudState& H) { return H.Help; }))
			.Visibility(Shown([](const FIpverseHudState& H) { return !H.bLoading; }))
		]
		// crosshair
		+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Center)
		[
			SNew(STextBlock).Font(HudFont(30)).Text(FText::FromString(TEXT("+")))
			.ColorAndOpacity(TAttribute<FSlateColor>::CreateLambda([S]() { return FSlateColor(S().Accent); }))
			.Visibility(Shown([](const FIpverseHudState& H) { return H.bCrosshair && !H.bLoading && H.Banner.IsEmpty(); }))
		]
		// interaction prompt + dialogue, bottom centre
		+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Bottom).Padding(0.f, 0.f, 0.f, 110.f)
		[
			SNew(SVerticalBox)
			+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center)
			[
				SNew(SBorder).BorderImage(White()).BorderBackgroundColor(FLinearColor(0.02f, 0.03f, 0.05f, 0.8f)).Padding(FMargin(28.f, 18.f))
				.Visibility(Shown([](const FIpverseHudState& H) { return !H.DialogueText.IsEmpty(); }))
				[
					SNew(SBox).MaxDesiredWidth(980.f)
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot().AutoHeight()
						[
							SNew(STextBlock).Font(HudFont(22)).Text(Text([](const FIpverseHudState& H) { return H.DialogueName; }))
							.ColorAndOpacity(TAttribute<FSlateColor>::CreateLambda([S]() { return FSlateColor(S().Accent); }))
						]
						+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 8.f, 0.f, 0.f)
						[
							SNew(STextBlock).Font(HudFont(26)).ColorAndOpacity(FLinearColor::White).AutoWrapText(true)
							.Text(Text([](const FIpverseHudState& H) { return H.DialogueText; }))
						]
					]
				]
			]
			+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center).Padding(0.f, 12.f, 0.f, 0.f)
			[
				SNew(SBorder).BorderImage(White()).BorderBackgroundColor(Panel).Padding(FMargin(16.f, 8.f))
				.Visibility(Shown([](const FIpverseHudState& H) { return !H.Prompt.IsEmpty() && !H.bLoading; }))
				[
					SNew(STextBlock).Font(HudFont(22)).ColorAndOpacity(FLinearColor::White)
					.Text(Text([](const FIpverseHudState& H) { return H.Prompt; }))
				]
			]
		]
		// win / lose banner
		+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Center)
		[
			SNew(SBorder).BorderImage(White()).BorderBackgroundColor(FLinearColor(0.f, 0.f, 0.f, 0.6f)).Padding(FMargin(60.f, 30.f))
			.Visibility(Shown([](const FIpverseHudState& H) { return !H.Banner.IsEmpty(); }))
			[
				SNew(SVerticalBox)
				+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center)
				[
					SNew(STextBlock).Font(HudFont(64)).Text(Text([](const FIpverseHudState& H) { return H.Banner; }))
					.ColorAndOpacity(TAttribute<FSlateColor>::CreateLambda([S]() { return FSlateColor(S().Accent); }))
				]
				+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center).Padding(0.f, 12.f, 0.f, 0.f)
				[
					SNew(STextBlock).Font(HudFont(26)).ColorAndOpacity(FLinearColor::White)
					.Text(Text([](const FIpverseHudState& H) { return H.BannerSub; }))
				]
			]
		]
		// loading curtain
		+ SOverlay::Slot().HAlign(HAlign_Fill).VAlign(VAlign_Fill)
		[
			SNew(SBorder).BorderImage(White()).BorderBackgroundColor(FLinearColor(0.01f, 0.012f, 0.02f, 1.f))
			.HAlign(HAlign_Center).VAlign(VAlign_Center)
			.Visibility(Shown([](const FIpverseHudState& H) { return H.bLoading; }))
			[
				SNew(STextBlock).Font(HudFont(36)).ColorAndOpacity(FLinearColor::White)
				.Text(Text([](const FIpverseHudState& H) { return H.LoadingText; }))
			]
		];

	Viewport->AddViewportWidgetContent(Root.ToSharedRef(), 10);
}

void AIpverseHud::EndPlay(const EEndPlayReason::Type Reason)
{
	if (Root.IsValid())
	{
		if (UGameViewportClient* Viewport = GetWorld() ? GetWorld()->GetGameViewport() : nullptr)
		{
			Viewport->RemoveViewportWidgetContent(Root.ToSharedRef());
		}
		Root.Reset();
	}
	Super::EndPlay(Reason);
}

#include "IpverseNpc.h"
#include "IpverseAssets.h"
#include "IpverseProceduralMotionComponent.h"

#include "Components/PointLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Kismet/GameplayStatics.h"
#include "GameFramework/Pawn.h"

using namespace IpverseAssets;

AIpverseNpc::AIpverseNpc()
{
	PrimaryActorTick.bCanEverTick = true;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	RootComponent->SetMobility(EComponentMobility::Movable);
	Motion = CreateDefaultSubobject<UIpverseProceduralMotionComponent>(TEXT("Motion"));
	Motion->SetupAttachment(RootComponent);
	Body = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Body"));
	Body->SetupAttachment(Motion);
	Body->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
	Body->SetCollisionProfileName(TEXT("BlockAll"));
	Marker = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Marker"));
	Marker->SetupAttachment(RootComponent);
	Marker->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Marker->SetCastShadow(false);
	Beacon = CreateDefaultSubobject<UPointLightComponent>(TEXT("Beacon"));
	Beacon->SetupAttachment(RootComponent);
	Beacon->SetRelativeLocation(FVector(0, 0, 260.f));
	Beacon->SetIntensity(12000.f);
	Beacon->SetAttenuationRadius(900.f);
	Beacon->SetCastShadows(false);
}

void AIpverseNpc::Setup(const FIpverseEntity* Entity, const FString& InName, const TArray<FString>& InLines, const FLinearColor& Accent)
{
	Name = InName;
	Lines = InLines;
	if (Lines.Num() == 0)
	{
		Lines.Add(TEXT("어서 오게, 여행자여. 이 골짜기에 온 걸 환영하네."));
	}
	if (Entity && Entity->Mesh)
	{
		FitMesh(Body, Entity->Mesh, 175.f, 0.f, Entity->YawOffset);
	}
	else
	{
		UMaterialInstanceDynamic* Robe = Tinted(this, TEXT("M_Surface"), FLinearColor(0.35f, 0.18f, 0.1f));
		Body->SetStaticMesh(Shape(EShape::Cone));
		Body->SetMaterial(0, Robe);
		Body->SetRelativeTransform(FTransform(FRotator::ZeroRotator, FVector(0, 0, 70.f), FVector(0.9f, 0.9f, 1.4f)));
		AddMesh(this, Shape(EShape::Sphere), Tinted(this, TEXT("M_Surface"), FLinearColor(0.8f, 0.62f, 0.5f)),
			FTransform(FRotator::ZeroRotator, FVector(0, 0, 160.f), FVector(0.42f)), false)
			->AttachToComponent(Motion, FAttachmentTransformRules::KeepRelativeTransform);
	}
	Marker->SetStaticMesh(Shape(EShape::Cone));
	Marker->SetMaterial(0, Tinted(this, TEXT("M_Glow"), Accent, 20.f));
	Marker->SetRelativeTransform(FTransform(FRotator(180.f, 0.f, 0.f), FVector(0, 0, 250.f), FVector(0.25f, 0.25f, 0.35f)));
	Beacon->SetLightColor(Accent);
}

void AIpverseNpc::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	Time += DeltaSeconds;
	Marker->SetVisibility(!bTalked);
	Marker->SetRelativeLocation(FVector(0, 0, 250.f + 10.f * FMath::Sin(Time * 3.f)));
	if (APawn* Player = UGameplayStatics::GetPlayerPawn(this, 0))
	{
		const FVector To = Player->GetActorLocation() - GetActorLocation();
		if (To.Size2D() < 900.f) // face the player
		{
			SetActorRotation(FMath::RInterpTo(GetActorRotation(), FRotator(0.f, To.Rotation().Yaw, 0.f), DeltaSeconds, 4.f));
		}
	}
}

// UE 5.6 + glTFRuntime 20260826 (cef7be2).
#include "IpverseSpecSubsystem.h"
#include "IpverseGame.h"

#include "HttpModule.h"
#include "Interfaces/IHttpResponse.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "HAL/PlatformMisc.h"
#include "Engine/StaticMesh.h"
#include "glTFRuntimeFunctionLibrary.h"
#include "glTFRuntimeAsset.h"

namespace
{
	constexpr int32 GManifestVersion = 1;

	FLinearColor HexColor(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Key, FLinearColor Fallback)
	{
		FString Hex;
		if (Obj.IsValid() && Obj->TryGetStringField(Key, Hex) && Hex.Len() == 7)
		{
			return FLinearColor::FromSRGBColor(FColor::FromHex(Hex));
		}
		return Fallback;
	}

	FIpverseEntity EntityFrom(const TSharedPtr<FJsonObject>& Obj, const FString& Role)
	{
		FIpverseEntity E;
		E.Role = Role;
		if (!Obj.IsValid())
		{
			return E;
		}
		Obj->TryGetStringField(TEXT("ipId"), E.IpId);
		Obj->TryGetStringField(TEXT("name"), E.Name);
		Obj->TryGetStringField(TEXT("effect"), E.Effect);
		Obj->TryGetStringField(TEXT("shape"), E.Shape);
		Obj->TryGetNumberField(TEXT("speed"), E.Speed);
		Obj->TryGetNumberField(TEXT("hp"), E.Hp);
		E.Color = HexColor(Obj, TEXT("color"), FLinearColor(1.f, 0.25f, 0.35f));
		return E;
	}
}

void UIpverseSpecSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	Load(); // downloads start while the stream connects and the pre-roll ad plays
}

FString UIpverseSpecSubsystem::ResolveSpecUrl() const
{
	FString Url;
	// bShouldStopOnSeparator=false: presigned URLs carry '&', '=', '%' and must not be cut.
	if (FParse::Value(FCommandLine::Get(), TEXT("IpverseSpecUrl="), Url, false) && !Url.IsEmpty())
	{
		return Url;
	}
	return FPlatformMisc::GetEnvironmentVariable(TEXT("IPVERSE_SPEC_URL"));
}

const FIpverseEntity* UIpverseSpecSubsystem::Player() const
{
	return Entities.FindByPredicate([](const FIpverseEntity& E) { return E.Role == TEXT("player"); });
}

TArray<FIpverseEntity> UIpverseSpecSubsystem::ByRole(const FString& Role) const
{
	return Entities.FilterByPredicate([&Role](const FIpverseEntity& E) { return E.Role == Role; });
}

void UIpverseSpecSubsystem::Load()
{
	if (State != EIpverseLoadState::Idle)
	{
		return;
	}
	const FString Url = ResolveSpecUrl();
	if (Url.IsEmpty())
	{
		// Demo mode (console "Test stream", local runs): default arena with a procedural hero.
		Entities.Add(FIpverseEntity{});
		Entities[0].Role = TEXT("player");
		for (int32 i = 0; i < 2; ++i)
		{
			FIpverseEntity Enemy;
			Enemy.Role = TEXT("enemy");
			Enemy.Shape = i == 0 ? TEXT("triangle") : TEXT("circle");
			Enemy.Color = i == 0 ? FLinearColor(1.f, 0.2f, 0.3f) : FLinearColor(1.f, 0.6f, 0.1f);
			Entities.Add(Enemy);
		}
		Title = TEXT("IPverse 데모 아레나");
		Finish(true);
		return;
	}
	if (!Url.StartsWith(TEXT("https://")))
	{
		Finish(false, TEXT("spec url must be https"));
		return;
	}
	State = EIpverseLoadState::Loading;
	UE_LOG(LogIpverse, Log, TEXT("Loading manifest")); // never log the URL: it is a bearer credential

	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Req = FHttpModule::Get().CreateRequest();
	Req->SetURL(Url);
	Req->SetVerb(TEXT("GET"));
	Req->SetTimeout(30.f);
	Req->OnProcessRequestComplete().BindUObject(this, &UIpverseSpecSubsystem::OnManifest);
	Req->ProcessRequest();
}

void UIpverseSpecSubsystem::OnManifest(FHttpRequestPtr Req, FHttpResponsePtr Resp, bool bOk)
{
	if (!bOk || !Resp.IsValid() || Resp->GetResponseCode() != 200)
	{
		Finish(false, FString::Printf(TEXT("manifest HTTP %d"), Resp.IsValid() ? Resp->GetResponseCode() : 0));
		return;
	}
	TMap<FString, FString> GlbUrls;
	if (!ParseManifest(Resp->GetContentAsString(), GlbUrls))
	{
		Finish(false, TEXT("manifest invalid"));
		return;
	}
	PendingGlbs = GlbUrls.Num();
	if (PendingGlbs == 0)
	{
		Finish(true);
		return;
	}
	for (const TPair<FString, FString>& It : GlbUrls)
	{
		TSharedRef<IHttpRequest, ESPMode::ThreadSafe> GlbReq = FHttpModule::Get().CreateRequest();
		GlbReq->SetURL(It.Value);
		GlbReq->SetVerb(TEXT("GET"));
		GlbReq->SetTimeout(60.f);
		GlbReq->OnProcessRequestComplete().BindUObject(this, &UIpverseSpecSubsystem::OnGlb, It.Key);
		GlbReq->ProcessRequest();
	}
}

bool UIpverseSpecSubsystem::ParseManifest(const FString& Body, TMap<FString, FString>& OutGlbUrls)
{
	TSharedPtr<FJsonObject> Root;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Body), Root) || !Root.IsValid())
	{
		return false;
	}
	int32 Version = 0;
	const TSharedPtr<FJsonObject>* SpecPtr = nullptr;
	if (!Root->TryGetNumberField(TEXT("manifestVersion"), Version) || Version != GManifestVersion
		|| !Root->TryGetObjectField(TEXT("spec"), SpecPtr))
	{
		return false;
	}
	const TSharedPtr<FJsonObject> Spec = *SpecPtr;
	// server/gamespec.py validated the GameSpec; read what the templates use.
	if (!Spec->TryGetStringField(TEXT("genre"), Genre))
	{
		return false;
	}
	Spec->TryGetStringField(TEXT("title"), Title);
	Spec->TryGetStringField(TEXT("difficulty"), Difficulty);
	const TSharedPtr<FJsonObject>* Obj = nullptr;
	if (Spec->TryGetObjectField(TEXT("objective"), Obj))
	{
		(*Obj)->TryGetStringField(TEXT("type"), ObjectiveType);
		(*Obj)->TryGetNumberField(TEXT("target"), ObjectiveTarget);
	}
	if (Spec->TryGetObjectField(TEXT("palette"), Obj))
	{
		Accent = HexColor(*Obj, TEXT("accent"), Accent);
	}
	if (Spec->TryGetObjectField(TEXT("map"), Obj))
	{
		(*Obj)->TryGetNumberField(TEXT("seed"), Seed);
	}
	if (Spec->TryGetObjectField(TEXT("quest"), Obj) && Obj->IsValid())
	{
		(*Obj)->TryGetStringField(TEXT("title"), QuestTitle);
	}

	// ips: { "<ipId>": { "role", "name", "glbUrl", "yaw" } }
	TMap<FString, FString> IpNames;
	const TSharedPtr<FJsonObject>* Ips = nullptr;
	TArray<FString> NpcIds;
	if (Root->TryGetObjectField(TEXT("ips"), Ips))
	{
		for (const TPair<FString, TSharedPtr<FJsonValue>>& It : (*Ips)->Values)
		{
			const TSharedPtr<FJsonObject> Ip = It.Value.IsValid() ? It.Value->AsObject() : nullptr;
			if (!Ip.IsValid())
			{
				continue;
			}
			FString GlbUrl, Role, Name;
			double Yaw = 0.0;
			if (Ip->TryGetStringField(TEXT("glbUrl"), GlbUrl) && GlbUrl.StartsWith(TEXT("https://")))
			{
				OutGlbUrls.Add(It.Key, GlbUrl);
			}
			if (Ip->TryGetStringField(TEXT("name"), Name))
			{
				IpNames.Add(It.Key, Name);
			}
			if (Ip->TryGetNumberField(TEXT("yaw"), Yaw))
			{
				Yaws.Add(It.Key, static_cast<float>(Yaw));
			}
			if (Ip->TryGetStringField(TEXT("role"), Role) && Role == TEXT("npc"))
			{
				NpcIds.Add(It.Key);
			}
		}
	}

	if (Spec->TryGetObjectField(TEXT("player"), Obj))
	{
		Entities.Add(EntityFrom(*Obj, TEXT("player")));
	}
	else
	{
		Entities.Add(EntityFrom(nullptr, TEXT("player")));
	}
	const TArray<TSharedPtr<FJsonValue>>* List = nullptr;
	if (Spec->TryGetArrayField(TEXT("enemies"), List))
	{
		for (const TSharedPtr<FJsonValue>& V : *List) { Entities.Add(EntityFrom(V->AsObject(), TEXT("enemy"))); }
	}
	if (Spec->TryGetArrayField(TEXT("props"), List))
	{
		for (const TSharedPtr<FJsonValue>& V : *List) { Entities.Add(EntityFrom(V->AsObject(), TEXT("prop"))); }
	}
	if (Spec->TryGetArrayField(TEXT("dialogue"), List))
	{
		for (const TSharedPtr<FJsonValue>& V : *List)
		{
			FString Text;
			if (V.IsValid() && V->AsObject().IsValid() && V->AsObject()->TryGetStringField(TEXT("text"), Text))
			{
				Dialogue.Add(Text);
			}
		}
	}
	for (const FString& NpcId : NpcIds)
	{
		FIpverseEntity Npc;
		Npc.IpId = NpcId;
		Npc.Role = TEXT("npc");
		Entities.Add(Npc);
	}
	for (FIpverseEntity& E : Entities)
	{
		if (E.Name.IsEmpty() && IpNames.Contains(E.IpId)) { E.Name = IpNames[E.IpId]; }
		if (Yaws.Contains(E.IpId)) { E.YawOffset = Yaws[E.IpId]; }
	}
	return true;
}

void UIpverseSpecSubsystem::OnGlb(FHttpRequestPtr Req, FHttpResponsePtr Resp, bool bOk, FString IpId)
{
	UStaticMesh* Mesh = nullptr;
	if (bOk && Resp.IsValid() && Resp->GetResponseCode() == 200)
	{
		FglTFRuntimeConfig Config; // default basis: glTF (Y-up, metres) -> UE (Z-up, centimetres)
		if (UglTFRuntimeAsset* Asset = UglTFRuntimeFunctionLibrary::glTFLoadAssetFromData(Resp->GetContent(), Config))
		{
			FglTFRuntimeStaticMeshConfig MeshConfig;
			MeshConfig.bBuildSimpleCollision = true;
			MeshConfig.PivotPosition = EglTFRuntimePivotPosition::Bottom; // feet at the origin
			Mesh = Asset->LoadStaticMeshRecursive(TEXT(""), {}, MeshConfig); // whole scene as one mesh
		}
	}
	UE_LOG(LogIpverse, Log, TEXT("GLB %s: %s"), *IpId, Mesh ? TEXT("loaded") : TEXT("FAILED, placeholder"));
	for (FIpverseEntity& E : Entities)
	{
		if (E.IpId == IpId) { E.Mesh = Mesh; }
	}
	if (--PendingGlbs == 0)
	{
		Finish(true); // a missing mesh degrades to a placeholder, never blocks the game
	}
}

void UIpverseSpecSubsystem::Finish(bool bSuccess, const FString& Why)
{
	State = bSuccess ? EIpverseLoadState::Ready : EIpverseLoadState::Failed;
	Failure = Why;
	if (Title.IsEmpty())
	{
		Title = TEXT("IPverse");
	}
	if (!bSuccess)
	{
		UE_LOG(LogIpverse, Error, TEXT("Spec load failed: %s"), *Why);
		if (Entities.Num() == 0)
		{
			Entities.Add(FIpverseEntity{});
			Entities[0].Role = TEXT("player");
		}
	}
	OnLoaded.Broadcast(bSuccess);
}

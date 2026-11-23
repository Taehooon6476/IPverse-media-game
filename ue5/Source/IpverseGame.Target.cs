// NOT COMPILED IN THIS REPO. UE 5.6.
using UnrealBuildTool;

public class IpverseGameTarget : TargetRules
{
	public IpverseGameTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.V5;
		IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_6;
		ExtraModuleNames.Add("IpverseGame");
	}
}

// NOT COMPILED IN THIS REPO. UE 5.6.
using UnrealBuildTool;

public class IpverseGameEditorTarget : TargetRules
{
	public IpverseGameEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.V5;
		IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_6;
		ExtraModuleNames.Add("IpverseGame");
	}
}

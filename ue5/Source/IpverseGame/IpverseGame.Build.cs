using UnrealBuildTool;

public class IpverseGame : ModuleRules
{
	public IpverseGame(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "InputCore" });
		PrivateDependencyModuleNames.AddRange(new[] {
			"HTTP", "Json", "Slate", "SlateCore", "AIModule", "ProceduralMeshComponent", "glTFRuntime" });
	}
}

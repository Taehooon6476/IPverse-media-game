#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"
#include "IpversePlayerController.generated.h"

/** Game-only input with a captured, hidden cursor (the Web SDK sends relative mouse motion). */
UCLASS()
class IPVERSEGAME_API AIpversePlayerController : public APlayerController
{
	GENERATED_BODY()

protected:
	virtual void BeginPlay() override;
};

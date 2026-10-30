import { Composition } from "remotion";
import { Banner, BlindRally, TOTAL } from "./BlindRally";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition id="BlindRally" component={BlindRally} durationInFrames={TOTAL} fps={30} width={1920} height={1080} />
      <Composition id="Banner" component={Banner} durationInFrames={1} fps={30} width={1600} height={640} />
    </>
  );
};

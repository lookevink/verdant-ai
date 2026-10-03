export const phases = ["dawn", "day", "golden", "dusk"] as const;
export type Phase = (typeof phases)[number];

// Inlined into <head> so the sky matches the visitor's local time before first paint. ?phase= overrides it.
export const phaseScript = `try{var p=new URLSearchParams(location.search).get("phase"),h=new Date().getHours();if(${JSON.stringify(phases)}.indexOf(p)<0)p=h>=5&&h<8?"dawn":h>=8&&h<17?"day":h>=17&&h<20?"golden":"dusk";document.documentElement.dataset.phase=p}catch(e){}`;

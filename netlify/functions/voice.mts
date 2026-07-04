import type { Context, Config } from "@netlify/functions";

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }

  const apiKey = Netlify.env.get("ELEVENLABS_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error:
          "ELEVENLABS_API_KEY is not set. In Netlify: Site configuration → Environment variables → add ELEVENLABS_API_KEY, then redeploy.",
      }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  let text: unknown;
  try {
    const body = await req.json();
    text = body?.text;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (typeof text !== "string" || text.length === 0 || text.length > 5000) {
    return new Response(JSON.stringify({ error: "Invalid text (1–5000 chars)" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  /* calm, steady default voice; override with ELEVENLABS_VOICE_ID */
  const voiceId = Netlify.env.get("ELEVENLABS_VOICE_ID") || "21m00Tcm4TlvDq8ikWAM";

  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_64`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.25 },
      }),
    }
  );

  if (!upstream.ok) {
    const err = await upstream.text();
    return new Response(JSON.stringify({ error: `ElevenLabs ${upstream.status}: ${err.slice(0, 300)}` }), {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  }

  const audio = await upstream.arrayBuffer();
  return new Response(audio, {
    status: 200,
    headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
  });
};

export const config: Config = {
  path: "/api/voice",
};

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

Deno.serve(async (request: Request) => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !key) {
    return Response.json({ error: "Supabase environment is missing" }, { status: 500 });
  }
  const client = createClient(url, key, {
    global: { headers: { Authorization: request.headers.get("Authorization") ?? `Bearer ${key}` } },
    auth: { persistSession: false },
  });
  const { data, error } = await client.from("sample_catalog").select("id,title").order("id").limit(1).single();
  if (error) return Response.json({ error: error.message }, { status: 502 });
  return Response.json({ row: data });
});

// Versão exata pinada (em vez de "@2") para que uma release nova do
// supabase-js não entre em produção sem passar por um commit e revisão.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.110.5";

// Preencha com os dados do SEU projeto Supabase (Project Settings > API) —
// ver scripts/README.md para o passo a passo completo de deploy. A chave
// abaixo é a "publishable"/"anon" key: pública por design (protegida por
// RLS no banco, não é segredo), mas ainda assim específica de cada projeto
// — nunca aponte para um projeto que não seja o seu.
export const SUPABASE_URL = "https://SEU-PROJETO.supabase.co";
export const SUPABASE_KEY = "sb_publishable_SUA_CHAVE_AQUI";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

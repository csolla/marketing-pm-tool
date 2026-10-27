// Supabase project for the Marketing PM Tool (separate from DSD Atlas).
// The public (anon) key is meant to be public: access is enforced by the
// database's row level security rules.
export const SUPABASE_URL = 'https://qaqntfsavgibdoctculy.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_BEWJJSwdW1G8rhUHcUG1Og_S0_dLlSq';

// Only these addresses can sign in (also enforced in the database)
export const ALLOWED_EMAIL_DOMAIN = 'digitalsmiledesign.com';

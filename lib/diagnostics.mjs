const hints = {
  DATABASE_URL_MISSING: 'DATABASE_URL is missing. Set the Supabase transaction pooler PostgreSQL URI in Vercel and redeploy. Supabase API keys cannot replace it.',
  DATABASE_URL_INVALID: 'DATABASE_URL is invalid. Copy the PostgreSQL URI from Supabase Connect and URL-encode the database password.',
  '28P01': 'Database authentication failed. Check the database password and pooler username in DATABASE_URL; do not use a Supabase API key.',
  '28000': 'Database authorization failed. Check the pooler username and project reference in DATABASE_URL.',
  '3D000': 'Database does not exist. Check the database name in DATABASE_URL.',
  '3F000': 'Application schema is missing. Run npm run db:migrate against this Supabase project.',
  '42P01': 'An application table is missing. Run npm run db:migrate against this Supabase project.',
  '42703': 'An application column is missing. Run npm run db:migrate against this Supabase project.',
  '42501': 'Database privileges are insufficient. Use the server database role that owns the application schemas.',
  ENOTFOUND: 'Database host could not be resolved. Check the host copied from Supabase Connect.',
  ECONNREFUSED: 'Database connection was refused. Check that Supabase is running and the pooler host and port are correct.',
  ENETUNREACH: 'Database network is unreachable. Use the IPv4-compatible Supabase transaction pooler for Vercel.',
  ETIMEDOUT: 'Database connection timed out. Check Supabase availability and network restrictions.',
  SELF_SIGNED_CERT_IN_CHAIN: 'Database TLS verification failed. Check DATABASE_CA_CERT against the Supabase server CA.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Database TLS verification failed. Check DATABASE_CA_CERT against the Supabase server CA.'
};

export function logFailure(context, error) {
  // Log actionable causes, never raw database messages/details, URLs, bodies or credentials.
  const code = String(error?.code || error?.name || 'Error');
  console.error(`${context}:`, {
    code,
    message: hints[code] || 'Unexpected server failure. Check database connectivity and run npm run db:check.'
  });
}

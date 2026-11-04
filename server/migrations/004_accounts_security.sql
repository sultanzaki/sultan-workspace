ALTER TABLE users ADD COLUMN title text NOT NULL DEFAULT '' CHECK(length(title)<=100);
ALTER TABLE users ADD COLUMN avatar_color text NOT NULL DEFAULT '#4B5BD6' CHECK(avatar_color ~ '^#[0-9A-Fa-f]{6}$');
ALTER TABLE users ADD COLUMN avatar bytea CHECK(octet_length(avatar)<=262144);
ALTER TABLE users ADD COLUMN avatar_mime text;
ALTER TABLE users ADD COLUMN avatar_updated_at timestamptz;
ALTER TABLE sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;
ALTER TABLE sessions ADD COLUMN user_agent text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN mfa_verified_at timestamptz;
CREATE TABLE user_security (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  secret text,
  pending_secret text,
  pending_until timestamptz,
  last_counter bigint NOT NULL DEFAULT -1
);
CREATE TABLE recovery_codes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  PRIMARY KEY(user_id,code_hash)
);
CREATE TABLE login_challenges (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remember boolean NOT NULL DEFAULT false,
  password_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX login_challenges_expiry_idx ON login_challenges(expires_at);

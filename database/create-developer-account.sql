-- ============================================================
-- Create Developer Account
-- Description: Inserts a developer user with full system access
-- Email:       admin@pulse.dev
-- Password:    1234  (bcrypt hash generated with saltRounds=10)
-- Role:        developer (bypasses all permission/role checks)
-- ============================================================

-- bcrypt hash for password '1234' (saltRounds = 10)
-- You can verify this hash at: https://bcrypt-generator.com/
-- Or run: node -e "const b=require('bcryptjs');b.hash('1234',10).then(console.log)"

INSERT INTO "user" (
    email,
    password,
    "firstName",
    "lastName",
    "jobTitle",
    organization,
    role,
    status,
    "createdAt"
) VALUES (
    'admin@pulse.dev',
    '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', -- bcrypt hash of '1234'
    'Admin',
    'Developer',
    'System Developer',
    'PULSE Development',
    'developer',
    'Active',
    NOW()
)
ON CONFLICT (email) DO UPDATE SET
    password  = EXCLUDED.password,
    role      = 'developer',
    status    = 'Active',
    "jobTitle" = 'System Developer';

-- Verify the account was created
SELECT
    id,
    email,
    "firstName",
    "lastName",
    role,
    status,
    "createdAt"
FROM "user"
WHERE email = 'admin@pulse.dev';

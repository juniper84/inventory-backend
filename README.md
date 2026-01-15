# inventory-backend

Backend API for New Vision Inventory (NestJS + Prisma).

## Project setup

```bash
npm install
```

## Compile and run the project

```bash
# development
npm run start

# watch mode
npm run start:dev

# production mode
npm run start:prod
```

## Run tests

```bash
# unit tests
npm run test

# e2e tests
npm run test:e2e
```

## Integration smoke runner

These scripts provide a repeatable, end-to-end backend smoke test against a running API.

```bash
# reset DB (destructive) - only for test databases
CONFIRM_DB_RESET=YES npx ts-node scripts/integration-reset.ts

# run the integration runner (requires backend running)
BACKEND_BASE_URL=http://localhost:3000/api/v1 \
  NVI_TEST_EMAIL=owner@test.local \
  NVI_TEST_PASSWORD=StrongPass123 \
  NVI_TEST_BUSINESS="NVI Test Business" \
  NVI_TEST_OWNER="Test Owner" \
  NVI_TEST_DEVICE="nvi-test-device" \
  npx ts-node scripts/integration-runner.ts
```

Notes:
- Use a dedicated test database. The reset script truncates all tables.
- The runner expects a fresh DB unless you customize the test email/business.

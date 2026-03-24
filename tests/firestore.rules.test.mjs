import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rules = await fs.readFile(path.resolve(__dirname, "../firestore.rules"), "utf8");

const testEnv = await initializeTestEnvironment({
  projectId: "tracksubfin-rules-test",
  firestore: { rules },
});

async function run() {
  await testEnv.clearFirestore();

  const owner = testEnv.authenticatedContext("owner-uid").firestore();
  const stranger = testEnv.authenticatedContext("stranger-uid").firestore();

  const ownerMemberRef = owner.doc("spaces/FAM123/members/owner-uid");
  const subRef = stranger.doc("spaces/FAM123/subscriptions/sub1");

  // 1) bootstrap owner allowed (new space)
  await assertSucceeds(
    owner.doc("spaces/FAM123/meta/access").set({
      ownerUid: "owner-uid",
      createdAt: new Date(),
    })
  );

  await assertSucceeds(
    ownerMemberRef.set({
      uid: "owner-uid",
      email: "owner@example.com",
      name: "Owner",
      inviteCode: "OWNER_BOOTSTRAP",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  );

  // 2) stranger cannot self-join by familyCode only
  await assertFails(
    stranger.doc("spaces/FAM123/members/stranger-uid").set({
      uid: "stranger-uid",
      email: "x@example.com",
      name: "X",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  );

  // 3) stranger cannot read subscriptions without membership
  await assertFails(subRef.get());

  await testEnv.cleanup();
}

run().then(
  () => {
    console.log("rules smoke tests passed");
  },
  async (err) => {
    console.error(err);
    await testEnv.cleanup();
    process.exit(1);
  }
);

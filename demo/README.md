# synqux demo

A manual demo for syncing a counter and ledger across devices with the Firebase emulator. It is not included in the npm package (`files: ["dist"]`), and CI does not depend on it.

## Getting Started

```sh
# 1. Start the RTDB emulator (requires Java; npx downloads firebase-tools)
npm run demo:emulator

# 2. Start the dev server in another terminal
npm run demo
# Open http://localhost:5173 in multiple tabs
```

- Use `?group=xxx` to choose a room. Use `?role=dedicated` or `?role=guest` to change roles.
- The alias reads src directly, so API changes appear without a build.

## Testcases

1. Click +1 in either of two tabs and see the update in both (matching application order).
2. The latest connected tab becomes HOST 👑. Close it and a remaining tab takes over (onDisconnect -> migration).
3. Reload the page and see the count restored (snapshot restore).
4. Keep clicking +10 past 100. The request is rejected and only that tab shows the message (reducer validation).
5. A tab with `?role=dedicated` always stays the host.
6. A tab with `?role=guest` never becomes the host (but can send requests).
7. Click the guest/player role buttons to call `setRole`. The self ID stays the same while the host role moves or another tab takes over.

## Stress mode

Counter additions produce the same value in any order, so use the ledger's running
hash to check the ordering guarantee and exactly-once application of concurrent requests.

1. Start the RTDB emulator and demo by following Getting Started.
2. Open at least three tabs in the same `group`.
3. Run `Storm x50` or `Storm x200` in each tab. You can also open every tab at
   the same URL with `?storm=200` to start automatically.
4. After the storms finish, wait until all requests settle.

Pruned requests beyond the 200-request limit are archived under `logs/{groupId}` and can be checked in the emulator UI.

The test passes when **the ledger count and hash match exactly in every tab**. Any
difference means there is a bug in ordering or exactly-once application.

Closing a tab during a storm adds host migration. A known tradeoff in the dual-host
window (SPEC-0001, "Design Tradeoffs") can cause a temporary divergence. Treat a
mismatch as a bug **only during stable operation without a host change**.

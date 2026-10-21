import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  beginLogin,
  completeLogin,
  getAccountState,
  getModelCatalog,
  removeAccount,
  reopenLogin,
  setPreferred,
  setModelPreference,
  switchAccount,
} from "./server/accounts";
import { getHealth, getSessions, planBalance, setSessionTier, startBalance } from "./server/balance";
import { getForceStatus, planForce, startForce } from "./server/force-account";
import { prepareClaudeSession } from "./server/claude-session";
import { syncOpenCodePluginsInBackground } from "./server/opencode-shims";
import {
  accountStateRpc,
  balancePlanRpc,
  balanceStartRpc,
  beginLoginRpc,
  healthRpc,
  completeLoginRpc,
  forcePlanRpc,
  forceStartRpc,
  forceStatusRpc,
  modelCatalogRpc,
  removeAccountRpc,
  reopenLoginRpc,
  sessionsRpc,
  setPreferredAccountRpc,
  setPreferredModelRpc,
  setTierRpc,
  switchAccountRpc,
} from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  server.handle(accountStateRpc, getAccountState);
  server.handle(beginLoginRpc, beginLogin);
  server.handle(completeLoginRpc, completeLogin);
  server.handle(reopenLoginRpc, reopenLogin);
  server.handle(switchAccountRpc, switchAccount);
  server.handle(removeAccountRpc, removeAccount);
  server.handle(setPreferredAccountRpc, setPreferred);
  server.handle(modelCatalogRpc, getModelCatalog);
  server.handle(setPreferredModelRpc, setModelPreference);
  server.handle(forcePlanRpc, planForce);
  server.handle(forceStartRpc, startForce);
  server.handle(forceStatusRpc, getForceStatus);
  server.handle(sessionsRpc, getSessions);
  server.handle(balancePlanRpc, planBalance);
  server.handle(balanceStartRpc, startBalance);
  server.handle(setTierRpc, setSessionTier);
  server.handle(healthRpc, getHealth);
  syncOpenCodePluginsInBackground();
  const unsubscribe = server.before("agent.session_open", ({ request }) => prepareClaudeSession(request));
  return unsubscribe;
}

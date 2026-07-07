import { Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products } from "plaid";
import { env } from "@/lib/env";

/**
 * The single Plaid client wrapper. ALL Plaid calls in the codebase go through
 * this module; nothing else may import the Plaid SDK (enforced by ESLint
 * no-restricted-imports).
 */

let client: PlaidApi | null = null;

function plaid(): PlaidApi {
  if (client) return client;
  const configuration = new Configuration({
    basePath: PlaidEnvironments[env().PLAID_ENV]!,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": env().PLAID_CLIENT_ID,
        "PLAID-SECRET": env().PLAID_SECRET,
      },
    },
  });
  client = new PlaidApi(configuration);
  return client;
}

export async function createLinkToken(userId: string): Promise<string> {
  const res = await plaid().linkTokenCreate({
    user: { client_user_id: userId },
    client_name: "SubTracker",
    products: [Products.Transactions],
    country_codes: [CountryCode.Ca, CountryCode.Us],
    language: "en",
    transactions: { days_requested: 730 },
    ...(env().PLAID_WEBHOOK_URL ? { webhook: env().PLAID_WEBHOOK_URL } : {}),
  });
  return res.data.link_token;
}

/** Link token in update mode, for re-authenticating an existing Item. */
export async function createUpdateLinkToken(userId: string, accessToken: string): Promise<string> {
  const res = await plaid().linkTokenCreate({
    user: { client_user_id: userId },
    client_name: "SubTracker",
    country_codes: [CountryCode.Ca, CountryCode.Us],
    language: "en",
    access_token: accessToken,
  });
  return res.data.link_token;
}

export type SyncedTransaction = {
  plaidTransactionId: string;
  plaidAccountId: string;
  date: string;
  amount: number;
  currency: string | null;
  rawDescriptor: string;
  pending: boolean;
  pfcPrimary: string | null;
  pfcDetailed: string | null;
  legacyCategories: string[];
};

export type SyncPage = {
  added: SyncedTransaction[];
  modified: SyncedTransaction[];
  removed: string[];
  nextCursor: string;
  hasMore: boolean;
};

/** One page of /transactions/sync. The caller loops on hasMore. */
export async function transactionsSyncPage(
  accessToken: string,
  cursor: string | null,
): Promise<SyncPage> {
  const res = await plaid().transactionsSync({
    access_token: accessToken,
    cursor: cursor ?? undefined,
    count: 500,
  });
  const map = (t: (typeof res.data.added)[number]): SyncedTransaction => ({
    plaidTransactionId: t.transaction_id,
    plaidAccountId: t.account_id,
    date: t.date,
    amount: t.amount,
    currency: t.iso_currency_code ?? null,
    rawDescriptor: t.name,
    pending: t.pending,
    pfcPrimary: t.personal_finance_category?.primary ?? null,
    pfcDetailed: t.personal_finance_category?.detailed ?? null,
    legacyCategories: t.category ?? [],
  });
  return {
    added: res.data.added.map(map),
    modified: res.data.modified.map(map),
    removed: res.data.removed.map((r) => r.transaction_id!),
    nextCursor: res.data.next_cursor,
    hasMore: res.data.has_more,
  };
}

/** Structural error check without importing Plaid types elsewhere. */
export function isItemLoginRequired(err: unknown): boolean {
  const data = (err as { response?: { data?: { error_code?: string } } })?.response?.data;
  return data?.error_code === "ITEM_LOGIN_REQUIRED";
}

/** Fetch a webhook verification JWK by key id (for signature checks). */
export async function getWebhookVerificationKey(keyId: string): Promise<Record<string, unknown>> {
  const res = await plaid().webhookVerificationKeyGet({ key_id: keyId });
  return res.data.key as unknown as Record<string, unknown>;
}

export async function exchangePublicToken(
  publicToken: string,
): Promise<{ accessToken: string; itemId: string }> {
  const res = await plaid().itemPublicTokenExchange({ public_token: publicToken });
  return { accessToken: res.data.access_token, itemId: res.data.item_id };
}

export type PlaidAccount = {
  plaidAccountId: string;
  name: string;
  type: string;
  mask: string | null;
  currency: string;
};

export async function getAccounts(
  accessToken: string,
): Promise<{ institutionId: string | null; accounts: PlaidAccount[] }> {
  const res = await plaid().accountsGet({ access_token: accessToken });
  return {
    institutionId: res.data.item.institution_id ?? null,
    accounts: res.data.accounts.map((a) => ({
      plaidAccountId: a.account_id,
      name: a.name,
      type: a.type,
      mask: a.mask ?? null,
      currency: a.balances.iso_currency_code ?? "CAD",
    })),
  };
}

export async function getInstitutionName(institutionId: string): Promise<string | null> {
  try {
    const res = await plaid().institutionsGetById({
      institution_id: institutionId,
      country_codes: [CountryCode.Ca, CountryCode.Us],
    });
    return res.data.institution.name;
  } catch {
    return null;
  }
}

export async function removeItem(accessToken: string): Promise<void> {
  await plaid().itemRemove({ access_token: accessToken });
}

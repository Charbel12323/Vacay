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
  });
  return res.data.link_token;
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

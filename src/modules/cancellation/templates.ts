import templates from "@/db/seeds/message-templates.json";

/**
 * Drafted-message rendering (Stage 8 task 3). Templates are reviewed
 * fixtures (message-templates.json), not inline strings; tone is
 * firm-polite. Rendering is strict: a missing merge field is a thrown
 * error, never a "{{placeholder}}" leaking into a user's message.
 */

export type TemplateId = keyof typeof templates;

export type MergeFields = {
  merchant: string;
  amount: string;
  cadence_label: string;
  first_name: string;
  old_price?: string;
  new_price?: string;
};

export type DraftMessage = { template_id: TemplateId; subject: string; body: string };

export function renderTemplate(id: TemplateId, fields: MergeFields): DraftMessage {
  const template = templates[id];
  return {
    template_id: id,
    subject: merge(template.subject, fields, id),
    body: merge(template.body, fields, id),
  };
}

function merge(text: string, fields: MergeFields, id: string): string {
  const rendered = text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = fields[key as keyof MergeFields];
    if (value === undefined || value === "") {
      throw new Error(`template "${id}" is missing merge field "${key}"`);
    }
    return value;
  });
  // Belt-and-suspenders: nothing placeholder-shaped may survive.
  if (/\{\{.*\}\}/.test(rendered)) {
    throw new Error(`template "${id}" rendered with leftover placeholders`);
  }
  return rendered;
}

export function cadenceLabel(cadence: string | null): string {
  return (
    {
      weekly: "per week",
      biweekly: "every two weeks",
      monthly: "per month",
      bimonthly: "every two months",
      quarterly: "per quarter",
      annual: "per year",
    }[cadence ?? ""] ?? "per billing period"
  );
}

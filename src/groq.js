import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const MAX_RETRIES = 3;
export const BASE_SERVICE_CONTEXT = 'Our AI custom voice agents act like an always-on receptionist for HVAC, roofing, plumbing, and other local trades, answering every call even when the team is on a job. They greet customers by name when possible, capture the exact service issue (no cooling, leak, emergency, quote request), and then qualify the lead with smart questions about location, urgency, and budget. Once qualified, they can instantly book appointments into the calendar, send confirmation SMS/email, and notify the business owner so no hot lead ever slips away. Over time, the agent learns common questions for that specific business (pricing ranges, service areas, warranties, promotions) and responds in a tone that matches the owner\'s brand voice. This turns missed calls and after-hours inquiries into consistent, trackable leads, while giving customers a fast, personalized experience that feels like talking to a dedicated office staff member.';

export function buildCampaignContext(userContext = '') {
  const trimmed = (userContext || '').trim();
  if (!trimmed) return BASE_SERVICE_CONTEXT;
  return `${BASE_SERVICE_CONTEXT}\n\nAdditional campaign context:\n${trimmed}`;
}

export function buildFallbackMessage({ name, bio, campaignContext, ctaLink }) {
  const firstName = (name || 'there').toString().trim().split(/\s+/)[0] || 'there';
  const hasBio = bio && bio.trim().length > 0;
  const serviceHint = (campaignContext || BASE_SERVICE_CONTEXT)
    .split(/[.!?\n]/)
    .map(s => s.trim())
    .find(Boolean) || 'We help local service businesses convert more inbound calls into booked jobs';

  const opener = hasBio
    ? `Hey ${firstName}, I noticed your background in ${bio.trim().slice(0, 90)}${bio.trim().length > 90 ? '…' : ''}.`
    : `Hey ${firstName}, hope you\'re doing well.`;

  return `${opener} ${serviceHint}. If helpful, here\'s a quick demo link: ${ctaLink}`.replace(/\s+/g, ' ').trim();
}

function normalizeMessage(text = '', ctaLink = '') {
  let normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  const badPatterns = [
    /let'?s craft/i,
    /we need to/i,
    /then pitch/i,
    /check characters/i,
    /use name/i,
    /provide pitch/i,
    /draft:/i,
    /^\.+\s*/, // starts with only punctuation/dots
  ];
  if (badPatterns.some(rx => rx.test(normalized))) {
    return '';
  }

  if (ctaLink && !normalized.includes(ctaLink)) {
    normalized = `${normalized} If helpful, here\'s a quick demo link: ${ctaLink}`;
  }

  normalized = normalized.replace(/\s+/g, ' ').trim();
  if (normalized.length < 40 || normalized.length > 500) return '';
  return normalized;
}

export async function generateMessage({ name, bio, campaignContext, ctaLink, model }) {
  const useModel = model || DEFAULT_MODEL;
  const finalCampaignContext = buildCampaignContext(campaignContext);
  const hasBio = bio && bio.trim().length > 0;

  const bioRule = hasBio
    ? '- Reference something specific from the recipient\'s bio to show genuine interest.'
    : '- The recipient has no bio, so greet them warmly by name and jump straight into the pitch.';

  const systemPrompt = `You are a friendly outreach copywriter. Write a casual, friendly 2-3 sentence Twitter DM.
Rules:
${bioRule}
- Subtly pitch the following service: ${finalCampaignContext}
- End the message by naturally sharing this link: ${ctaLink}
- Do NOT be overly formal or salesy.
- Do NOT use hashtags or emojis.
- Keep it under 500 characters.
- Return ONLY the DM text — no quotes, no preamble, no explanation.`;

  const userPrompt = hasBio
    ? `Recipient name: ${name || 'there'}\nRecipient bio: ${bio}`
    : `Recipient name: ${name || 'there'}`;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await groq.chat.completions.create({
        model: useModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.8,
        max_tokens: 300,
      });

      const choice = response.choices?.[0];
      let text = choice?.message?.content?.trim();

      // Some reasoning models put tokens in a 'reasoning' field and leave content empty.
      // Fall back to extracting the DM from reasoning if content is blank.
      if ((!text || text.length <= 5) && choice?.message?.reasoning) {
        const reasoning = String(choice.message.reasoning);
        // Look for quoted DM text inside reasoning
        const quoted = reasoning.match(/"([^"]{20,})"/s) || reasoning.match(/'([^']{20,})'/s);
        if (quoted) text = quoted[1].trim();
      }

      const normalized = normalizeMessage(text, ctaLink);
      if (normalized) {
        console.log(`[Groq] Generated ${normalized.length} chars on attempt ${attempt} for ${name}`);
        return normalized;
      }

      lastError = new Error(`Groq returned empty/short message (attempt ${attempt}/${MAX_RETRIES})`);
      console.warn(`[Groq] Empty response on attempt ${attempt}, retrying...`);
      await new Promise(r => setTimeout(r, 1500 * attempt));
    } catch (err) {
      lastError = err;
      console.warn(`[Groq] API error on attempt ${attempt}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }

  const fallback = buildFallbackMessage({ name, bio, campaignContext: finalCampaignContext, ctaLink });
  console.warn(`[Groq] Using deterministic fallback for ${name}. Last error: ${lastError?.message || 'unknown'}`);
  return fallback;
}

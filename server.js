require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const cors = require('cors');

// Validate required env vars at startup so failures are obvious in Railway logs
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
  console.error('FATAL: Missing environment variables:', missingEnv.join(', '));
  console.error('Set these in Railway > Variables before deploying.');
  process.exit(1);
}

const app = express();
app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(express.json());

// SUPABASE
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// RESEND EMAIL
const resend = new Resend(process.env.RESEND_API_KEY);

// HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// SUBMIT CASE
app.post('/api/submit-case', async (req, res) => {
  try {
    const b = req.body;
    // Accept both Dutch field names (direct API) and English field names (Lovable website)
    const bedrijfsnaam          = b.bedrijfsnaam          || b.companyName    || '';
    const contactpersoon        = b.contactpersoon        || b.contactName    || '';
    const email_bedrijf         = b.emailBedrijf          || b.email          || '';
    const telefoon_bedrijf      = b.telefoonBedrijf       || b.phone          || '';
    const debiteur_naam         = b.debiteurNaam          || b.debtorName     || '';
    const debiteur_contactpersoon = b.debiteurContactpersoon || b.debtorContact || '';
    const email_debiteur        = b.emailDebiteur         || b.debtorEmail    || '';
    const telefoon_debiteur     = b.telefoonDebiteur      || b.debtorPhone    || '';
    const factuurnummer         = b.factuurnummer         || b.invoiceNumber  || '';
    const bedrag                = b.bedrag                || b.amount         || 0;
    const factuurdatum          = b.factuurdatum          || b.invoiceDate    || '';
    const vervaldatum           = b.vervaldatum           || b.dueDate        || '';
    const omschrijving          = b.omschrijving          || b.description    || '';
    const type_indiening        = b.typeIndiening         || b.submissionType || 'single';
    const reden_wanbetaling     = b.redenWanbetaling      || b.reason         || '';
    const extra_informatie      = b.extraInformatie       || b.additionalInfo || '';
    // bankgegevens: direct veld OF samengesteld uit iban + tenaamstelling (Lovable)
    const bankgegevens          = b.bankgegevens
      || (b.iban ? `${b.iban}${b.accountHolder ? ' t.n.v. ' + b.accountHolder : ''}` : '')
      || '';

    console.log('Received case:', { factuurnummer, email_debiteur, bedrijfsnaam });

    // Categorize
    let categorie = 'betaling_vergeten';
    if (reden_wanbetaling) {
      const reden = reden_wanbetaling.toLowerCase();
      if (reden.includes('dispute') || reden.includes('niet eens')) {
        categorie = 'dispute';
      } else if (reden.includes('geen contact') || reden.includes('niet bereikbaar')) {
        categorie = 'geen_communicatie';
      } else if (reden.includes('financieel') || reden.includes('moeilijk')) {
        categorie = 'financiele_moeilijkheden';
      }
    }

    console.log('Category:', categorie);

    // Check of case al bestaat (Lovable insert direct naar Supabase)
    const { data: existingCase } = await supabase
      .from('cases')
      .select('id')
      .eq('factuurnummer', factuurnummer)
      .maybeSingle();

    if (existingCase) {
      console.log('Case already exists (Lovable direct insert), skipping insert:', factuurnummer);
    } else {
      // Insert case in Supabase
      const { error: caseError } = await supabase
        .from('cases')
        .insert([{
          bedrijfsnaam,
          contactpersoon,
          email_bedrijf,
          telefoon_bedrijf,
          debiteur_naam,
          debiteur_contactpersoon,
          email_debiteur,
          telefoon_debiteur,
          factuurnummer,
          bedrag: bedrag ? parseFloat(bedrag) : 0,
          factuurdatum,
          vervaldatum,
          omschrijving,
          type_indiening,
          reden_wanbetaling,
          extra_informatie,
          bankgegevens,
          email_categorie: categorie,
          status: 'submitted'
        }]);

      if (caseError) {
        console.error('Case insert error:', JSON.stringify(caseError));
        return res.status(500).json({ error: 'Database insert failed: ' + caseError.message });
      }
      console.log('Case inserted successfully');
    }

    // Send email in background via Resend (non-blocking)
    (async () => {
      try {
        const { data: template, error: templateError } = await supabase
          .from('email_templates')
          .select('*')
          .eq('categorie', categorie)
          .single();

        if (templateError) {
          console.error('Template fetch error:', JSON.stringify(templateError));
          return;
        }

        if (!template) {
          console.warn('No email template found for categorie:', categorie);
          return;
        }

        // Alle form-velden als variabelen — elk {{veld}} in template wordt automatisch ingevuld
        const vars = {
          factuurnummer:          factuurnummer || '',
          bedrag:                 bedrag || '',
          factuurdatum:           factuurdatum || '',
          vervaldatum:            vervaldatum || '',
          debiteur_naam:          debiteur_naam || '',
          debiteur_contactpersoon: debiteur_contactpersoon || '',
          bedrijfsnaam:           bedrijfsnaam || '',
          contactpersoon:         contactpersoon || '',
          email_bedrijf:          email_bedrijf || '',
          telefoon_bedrijf:       telefoon_bedrijf || '',
          omschrijving:           omschrijving || '',
          reden_wanbetaling:      reden_wanbetaling || '',
          extra_informatie:       extra_informatie || '',
          email_debiteur:         email_debiteur || '',
          telefoon_debiteur:      telefoon_debiteur || '',
          type_indiening:         type_indiening || '',
          bankgegevens:           bankgegevens || '',
        };

        const fill = (tmpl) => tmpl.replace(/{{(\w+)}}/g, (_, key) => vars[key] ?? '');

        const subject = fill(template.subject_template);
        const body    = fill(template.body_template);

        // Resend SDK v2 returns { data, error } — not a direct object
        const { data: emailData, error: emailSendError } = await resend.emails.send({
          from: 'Betaalopvolging Nederland <noreply@mail.fixjebetaling.nl>',
          to: email_debiteur,
          subject: subject,
          html: body
        });

        if (emailSendError) {
          console.error('Resend error:', JSON.stringify(emailSendError));
          return;
        }

        console.log('Email sent via Resend:', { to: email_debiteur, id: emailData.id });

        // Log email send
        await supabase
          .from('email_logs')
          .insert([{
            recipient_email: email_debiteur,
            subject: subject,
            status: 'sent'
          }]);

        // Update case status
        await supabase
          .from('cases')
          .update({ email_sent_at: new Date().toISOString(), status: 'email_sent' })
          .eq('factuurnummer', factuurnummer);

      } catch (err) {
        console.error('Email background error:', err.message);
      }
    })();

    // Create campaign in background (non-blocking)
    (async () => {
      try {
        const { data: caseData } = await supabase
          .from('cases')
          .select('id')
          .eq('factuurnummer', factuurnummer)
          .single();

        if (caseData) {
          await supabase
            .from('email_campaigns')
            .insert([{
              case_id: caseData.id,
              debiteur_email: email_debiteur,
              current_step: 1,
              status: 'sent',
              email_1_sent_at: new Date().toISOString()
            }]);
          console.log('Campaign created for case:', caseData.id);
        }
      } catch (campaignError) {
        console.error('Campaign error:', campaignError.message);
      }
    })();

    return res.status(200).json({
      success: true,
      message: 'Case submitted successfully',
      categorie: categorie
    });

  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// PROCESS CAMPAIGNS — wordt dagelijks aangeroepen door cron
app.post('/api/process-campaigns', async (req, res) => {
  // Beveilig met secret zodat alleen de cron dit kan aanroepen
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const results = { step2_sent: 0, step3_sent: 0, errors: [] };

  // Helper: vul alle {{variabelen}} in template in vanuit case-data
  const fill = (tmpl, c) => tmpl.replace(/{{(\w+)}}/g, (_, key) => c[key] ?? '');

  // Helper: haal template op per categorie
  const getTemplate = async (categorie) => {
    const { data } = await supabase
      .from('email_templates')
      .select('*')
      .eq('categorie', categorie)
      .single();
    return data;
  };

  // Helper: stuur email en log het
  const sendCampaignEmail = async (to, subject, html) => {
    const { data, error } = await resend.emails.send({
      from: 'Betaalopvolging Nederland <noreply@mail.fixjebetaling.nl>',
      to, subject, html
    });
    if (error) throw new Error(JSON.stringify(error));
    return data.id;
  };

  try {
    // ── STAP 2: 5 dagen na Mail 1 ──────────────────────────────
    const fiveDaysAgo = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const { data: step2List } = await supabase
      .from('email_campaigns')
      .select('*, cases(*)')
      .eq('current_step', 1)
      .eq('status', 'sent')
      .lt('email_1_sent_at', fiveDaysAgo);

    for (const campaign of step2List || []) {
      try {
        const c = campaign.cases;
        const template = await getTemplate('geen_communicatie');
        if (!template || !c) continue;

        const subject = fill(template.subject_template, c);
        const html    = fill(template.body_template, c);
        await sendCampaignEmail(campaign.debiteur_email, subject, html);

        await supabase.from('email_campaigns')
          .update({ current_step: 2, status: 'step2_sent', email_2_sent_at: now.toISOString() })
          .eq('id', campaign.id);

        await supabase.from('email_logs').insert([{
          recipient_email: campaign.debiteur_email,
          subject, status: 'sent'
        }]);

        results.step2_sent++;
        console.log('Step 2 email sent to:', campaign.debiteur_email);
      } catch (e) {
        results.errors.push({ step: 2, campaign_id: campaign.id, error: e.message });
        console.error('Step 2 error:', e.message);
      }
    }

    // ── STAP 3: 7 dagen na Mail 2 ──────────────────────────────
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: step3List } = await supabase
      .from('email_campaigns')
      .select('*, cases(*)')
      .eq('current_step', 2)
      .eq('status', 'step2_sent')
      .lt('email_2_sent_at', sevenDaysAgo);

    for (const campaign of step3List || []) {
      try {
        const c = campaign.cases;
        const template = await getTemplate('financiele_moeilijkheden');
        if (!template || !c) continue;

        const subject = fill(template.subject_template, c);
        const html    = fill(template.body_template, c);
        await sendCampaignEmail(campaign.debiteur_email, subject, html);

        await supabase.from('email_campaigns')
          .update({ current_step: 3, status: 'step3_sent', email_3_sent_at: now.toISOString() })
          .eq('id', campaign.id);

        await supabase.from('email_logs').insert([{
          recipient_email: campaign.debiteur_email,
          subject, status: 'sent'
        }]);

        results.step3_sent++;
        console.log('Step 3 email sent to:', campaign.debiteur_email);
      } catch (e) {
        results.errors.push({ step: 3, campaign_id: campaign.id, error: e.message });
        console.error('Step 3 error:', e.message);
      }
    }

    return res.json({ success: true, ...results });
  } catch (error) {
    console.error('Process campaigns error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// GET CASES
app.get('/api/cases', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cases')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// UPDATE CAMPAIGN STATUS (betaald / gestopt)
app.put('/api/campaigns/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowed = ['paid', 'stopped', 'sent', 'step2_sent', 'step3_sent'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Ongeldige status. Gebruik: paid, stopped, sent, step2_sent of step3_sent' });
    }

    const { data, error } = await supabase
      .from('email_campaigns')
      .update({ status })
      .eq('id', id)
      .select();

    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Campagne niet gevonden' });
    }

    console.log(`Campaign ${id} status updated to: ${status}`);
    return res.json({ success: true, campaign: data[0] });
  } catch (error) {
    console.error('Update campaign status error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// GET CAMPAIGNS
app.get('/api/campaigns', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('email_campaigns')
      .select('*, cases(bedrijfsnaam, debiteur_naam, factuurnummer, bedrag, email_debiteur)')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET TEMPLATES
app.get('/api/templates', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('email_templates')
      .select('*');

    if (error) throw error;
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// UPDATE TEMPLATE
app.put('/api/templates/:categorie', async (req, res) => {
  try {
    const { categorie } = req.params;
    const { subject_template, body_template, tone } = req.body;

    const { data, error } = await supabase
      .from('email_templates')
      .update({ subject_template, body_template, tone, updated_at: new Date() })
      .eq('categorie', categorie)
      .select();

    if (error) throw error;
    return res.json({ success: true, data: data[0] });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// STATS
app.get('/api/stats', async (req, res) => {
  try {
    const { data: cases } = await supabase.from('cases').select('*');
    const { data: campaigns } = await supabase.from('email_campaigns').select('*');
    const { data: logs } = await supabase.from('email_logs').select('*');

    return res.json({
      cases: {
        total: cases?.length || 0,
        by_category: {}
      },
      emails: {
        total: logs?.length || 0,
        by_status: {}
      }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

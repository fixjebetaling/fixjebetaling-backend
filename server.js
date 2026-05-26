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
    const bedrijfsnaam = b.bedrijfsnaam;
    const contactpersoon = b.contactpersoon;
    const email_bedrijf = b.emailBedrijf;
    const telefoon_bedrijf = b.telefoonBedrijf;
    const debiteur_naam = b.debiteurNaam;
    const debiteur_contactpersoon = b.debiteurContactpersoon || '';
    const email_debiteur = b.emailDebiteur;
    const telefoon_debiteur = b.telefoonDebiteur;
    const factuurnummer = b.factuurnummer;
    const bedrag = b.bedrag;
    const factuurdatum = b.factuurdatum;
    const vervaldatum = b.vervaldatum;
    const omschrijving = b.omschrijving;
    const type_indiening = b.typeIndiening || 'single';
    const reden_wanbetaling = b.redenWanbetaling;
    const extra_informatie = b.extraInformatie || '';

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
        email_categorie: categorie,
        status: 'submitted'
      }]);

    if (caseError) {
      console.error('Case insert error:', JSON.stringify(caseError));
      return res.status(500).json({ error: 'Database insert failed: ' + caseError.message });
    }

    console.log('Case inserted successfully');

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

        const subject = template.subject_template
          .replace(/{{factuurnummer}}/g, factuurnummer || '')
          .replace(/{{bedrag}}/g, bedrag || '')
          .replace(/{{debiteur_naam}}/g, debiteur_naam || '');

        const body = template.body_template
          .replace(/{{factuurnummer}}/g, factuurnummer || '')
          .replace(/{{bedrag}}/g, bedrag || '')
          .replace(/{{debiteur_naam}}/g, debiteur_naam || '')
          .replace(/{{debiteur_contactpersoon}}/g, debiteur_contactpersoon || '')
          .replace(/{{bedrijfsnaam}}/g, bedrijfsnaam || '')
          .replace(/{{contactpersoon}}/g, contactpersoon || '')
          .replace(/{{email_bedrijf}}/g, email_bedrijf || '')
          .replace(/{{telefoon_bedrijf}}/g, telefoon_bedrijf || '')
          .replace(/{{omschrijving}}/g, omschrijving || '');

        // Resend SDK v2 returns { data, error } — not a direct object
        const { data: emailData, error: emailSendError } = await resend.emails.send({
          from: 'Betaalopvolging Nederland <noreply@notify.fixjebetaling.nl>',
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

// GET CAMPAIGNS
app.get('/api/campaigns', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('email_campaigns')
      .select('*')
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

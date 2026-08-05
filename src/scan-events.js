async function extractEventDate(page) {
  try {
    // Run DOM logic inside the page to reliably locate the "Notikuma datums" container
    const dateStr = await page.evaluate(() => {
      function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        return true;
      }

      function tryNormalizeParts(parts) {
        if (!parts || parts.length < 3) return null;
        const y = String(parts[0]).trim();
        const mo = String(parts[1]).trim();
        const d = String(parts[2]).trim();
        if (!/^\d{4}$/.test(y)) return null;
        if (!/^\d{1,2}$/.test(mo)) return null;
        if (!/^\d{1,2}$/.test(d)) return null;
        const mi = parseInt(mo, 10);
        const di = parseInt(d, 10);
        if (mi < 1 || mi > 12) return null;
        if (di < 1 || di > 31) return null;
        const moP = String(mi).padStart(2, '0');
        const dP = String(di).padStart(2, '0');
        return `${y}-${moP}-${dP}`;
      }

      // 1) Prefer fieldset/containers whose legend or visible heading contains "Notikuma datums"
      const textMatcher = /Notikuma\s+datums/i;

      // Check fieldsets first
      const fieldsets = Array.from(document.querySelectorAll('fieldset'));
      for (const fs of fieldsets) {
        const legend = fs.querySelector('legend');
        if (legend && textMatcher.test(legend.textContent || '')) {
          const inputs = Array.from(fs.querySelectorAll('input')).filter(i => !i.disabled && i.type !== 'hidden');
          if (inputs.length >= 3) {
            const vals = [inputs[0].value, inputs[1].value, inputs[2].value];
            const iso = tryNormalizeParts(vals);
            if (iso) return iso;
          }
        }
      }

      // Search common heading labels near inputs
      const headingSelectors = ['legend', 'label', 'h1', 'h2', 'h3', 'h4', 'strong', 'b'];
      for (const sel of headingSelectors) {
        const nodes = Array.from(document.querySelectorAll(sel));
        for (const node of nodes) {
          if (textMatcher.test(node.textContent || '')) {
            // look for inputs inside the closest container (fieldset, .form-group, .editor, div)
            const container = node.closest('fieldset, .form-group, .editor, .editor-section, .container, .row, div') || node.parentElement;
            if (container) {
              const inputs = Array.from(container.querySelectorAll('input')).filter(i => !i.disabled && i.type !== 'hidden');
              if (inputs.length >= 3) {
                const vals = [inputs[0].value, inputs[1].value, inputs[2].value];
                const iso = tryNormalizeParts(vals);
                if (iso) return iso;
              }
              // also try to look in siblings
              const siblingInputs = Array.from(container.parentElement ? container.parentElement.querySelectorAll('input') : []).filter(i => !i.disabled && i.type !== 'hidden');
              if (siblingInputs.length >= 3) {
                const vals2 = [siblingInputs[0].value, siblingInputs[1].value, siblingInputs[2].value];
                const iso2 = tryNormalizeParts(vals2);
                if (iso2) return iso2;
              }
            }
          }
        }
      }

      // 2) Fallback: first three small text inputs on the page, but only if they look like year/month/day
      const allInputs = Array.from(document.querySelectorAll('input')).filter(i => !i.disabled && i.type !== 'hidden' && isVisible(i));
      if (allInputs.length >= 3) {
        // prefer inputs with small maxlength or class names that indicate date parts
        const candidates = allInputs.slice(0, 10); // limit search
        for (let i = 0; i <= Math.max(0, candidates.length - 3); i++) {
          const a = candidates[i];
          const b = candidates[i + 1];
          const c = candidates[i + 2];
          if (!a || !b || !c) continue;
          const vals = [a.value, b.value, c.value].map(v => (v || '').trim());
          const iso = tryNormalizeParts(vals);
          if (iso) return iso;
        }
      }

      return null;
    });

    if (!dateStr) return null;

    // dateStr should already be YYYY-MM-DD
    const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return dateStr;
  } catch (e) {
    return null;
  }
}

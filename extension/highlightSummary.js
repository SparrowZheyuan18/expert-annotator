(function () {
  const summarySection = document.getElementById("highlight-summary");
  if (!summarySection) {
    return;
  }

  const state = {
    docs: new Map(),
    order: [],
  };

  let editHandler = null;
  let reviewHandler = null;

  const containerEl = summarySection.querySelector("#highlight-list .doc-list");
  const progressLabel = document.getElementById("highlight-progress");

  function formatLabel(label) {
    if (!label) {
      return "";
    }
    if (label.includes(" ")) {
      return label;
    }
    return label
      .split("_")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function getDocKey(entry) {
    return entry.documentId || entry.document_id || entry.document?.id || entry.id;
  }

  function ensureDoc(entry) {
    const key = getDocKey(entry);
    if (!key) {
      return null;
    }
    let doc = state.docs.get(key);
    if (!doc) {
      const sentiment = entry.documentSentiment || entry.sentiment || "neutral_information";
      doc = {
        id: key,
        title: entry.title || entry.documentTitle || entry.url || "Untitled",
        url: entry.url || entry.documentUrl || "",
        type: entry.type || entry.documentType || "html",
        highlights: [],
        collapsed: false,
        sentiment,
        savedReview: entry.documentReview || null,
        globalJudgment: entry.documentSummary || entry.globalJudgment || null,
        orderCounter: 0,
      };
      if (doc.savedReview?.sentiment) {
        doc.sentiment = doc.savedReview.sentiment;
      }
      if (!state.order.includes(key)) {
        state.order.push(key);
      }
      state.docs.set(key, doc);
    }
    if (entry.documentReview && entry.documentReview !== doc.savedReview) {
      doc.savedReview = entry.documentReview;
      if (entry.documentReview.sentiment) {
        doc.sentiment = entry.documentReview.sentiment;
      }
    }
    if (Object.prototype.hasOwnProperty.call(entry, "documentSummary")) {
      doc.globalJudgment = entry.documentSummary || null;
    } else if (Object.prototype.hasOwnProperty.call(entry, "globalJudgment")) {
      doc.globalJudgment = entry.globalJudgment || null;
    }
    return doc;
  }

  function mapHighlight(entry, doc) {
    const highlightId = entry.highlightId || entry.highlight_id || null;
    const localId = entry.localId || entry.local_id || null;
    const reviewSource = entry.documentReview || doc.savedReview || null;
    const rankFromReview = reviewSource && Array.isArray(reviewSource.highlight_order)
      ? reviewSource.highlight_order.indexOf(highlightId)
      : -1;
    const rank = entry.rank || (rankFromReview >= 0 ? rankFromReview + 1 : entry.highlightRank || null);
    return {
      id: entry.id || entry.highlightId || entry.localId || `${doc.id}-hl-${doc.orderCounter}`,
      highlightId,
      localId,
      text: entry.text || "",
      page: entry.page || entry.selector?.page || null,
      url: entry.url || doc.url,
      title: entry.title || doc.title,
      type: entry.type || doc.type,
      fingerprint: entry.fingerprint || null,
      selector: entry.selector || {},
      user_judgment: entry.user_judgment || {},
      ai_suggestions: entry.ai_suggestions || [],
      context: entry.context || null,
      documentId: doc.id,
      documentTitle: doc.title,
      documentUrl: doc.url,
      documentType: doc.type,
      rank: Number.isFinite(rank) ? Number(rank) : null,
      addedIndex: doc.orderCounter++,
    };
  }

  function sortHighlights(doc) {
    doc.highlights.sort((a, b) => {
      const rankA = Number.isFinite(a.rank) ? a.rank : Infinity;
      const rankB = Number.isFinite(b.rank) ? b.rank : Infinity;
      if (rankA !== rankB) {
        return rankA - rankB;
      }
      return a.addedIndex - b.addedIndex;
    });
  }

  function renderProgress() {
    let total = 0;
    state.docs.forEach((doc) => {
      total += doc.highlights.length;
    });
    progressLabel.textContent = `${total} highlight${total === 1 ? "" : "s"}`;
    summarySection.hidden = total === 0;
  }

  function createHighlightRow(doc, highlight) {
    const row = document.createElement("div");
    row.className = "doc-highlight-row";
    row.dataset.highlightId = highlight.id;

    const textBlock = document.createElement("div");
    textBlock.className = "doc-highlight-text";
    if (doc.type === "pdf" && Number.isFinite(highlight.rank)) {
      const rankBadge = document.createElement("span");
      rankBadge.className = "doc-highlight-rank";
      rankBadge.textContent = `#${highlight.rank}`;
      textBlock.appendChild(rankBadge);
    }
    const snippet = document.createElement("blockquote");
    snippet.textContent = highlight.text || "(empty snippet)";
    textBlock.appendChild(snippet);
    if (highlight.page) {
      const meta = document.createElement("span");
      meta.className = "doc-highlight-meta";
      meta.textContent = `Page ${highlight.page}`;
      textBlock.appendChild(meta);
    }

    const actionBlock = document.createElement("div");
    actionBlock.className = "doc-highlight-actions";

    const viewBtn = document.createElement("button");
    viewBtn.className = "secondary";
    viewBtn.textContent = "View";
    viewBtn.addEventListener("click", () => {
      window.open(doc.url || highlight.url, "_blank", "noopener");
    });
    actionBlock.appendChild(viewBtn);

    const editBtn = document.createElement("button");
    editBtn.className = "secondary";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      if (typeof editHandler === "function") {
        editHandler(highlight);
      }
    });
    actionBlock.appendChild(editBtn);

    row.appendChild(textBlock);
    row.appendChild(actionBlock);
    return row;
  }

  function renderDoc(doc) {
    const details = document.createElement("details");
    details.className = "doc-group";
    details.dataset.docId = doc.id;
    details.open = !doc.collapsed;
    details.addEventListener("toggle", () => {
      doc.collapsed = !details.open;
    });

    const summary = document.createElement("summary");
    summary.textContent = `${doc.title} (${doc.highlights.length})`;
    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "doc-body";

    if (doc.globalJudgment) {
      const summaryCard = document.createElement("div");
      summaryCard.className = "doc-summary-card";

      const headerEl = document.createElement("div");
      headerEl.className = "doc-summary-card__header";
      const titleEl = document.createElement("span");
      titleEl.className = "doc-summary-card__title";
      titleEl.textContent = "Paper Summary";
      headerEl.appendChild(titleEl);

      if (doc.globalJudgment.timestamp) {
        const date = new Date(doc.globalJudgment.timestamp);
        if (!Number.isNaN(date.getTime())) {
          const timestampLabel = document.createElement("span");
          timestampLabel.className = "doc-summary-card__timestamp";
          timestampLabel.textContent = date.toLocaleString();
          headerEl.appendChild(timestampLabel);
        }
      }

      const contentEl = document.createElement("div");
      contentEl.className = "doc-summary-card__content";

      const finalRow = document.createElement("div");
      finalRow.className = "doc-summary-card__row";
      const finalLabel = document.createElement("span");
      finalLabel.className = "label";
      finalLabel.textContent = "Final thoughts";
      const finalValue = document.createElement("span");
      finalValue.className = "value";
      finalValue.textContent = doc.globalJudgment.final_thoughts || "—";
      finalRow.appendChild(finalLabel);
      finalRow.appendChild(finalValue);
      contentEl.appendChild(finalRow);

      if (doc.globalJudgment.next_steps) {
        const nextRow = document.createElement("div");
        nextRow.className = "doc-summary-card__row";
        const nextLabel = document.createElement("span");
        nextLabel.className = "label";
        nextLabel.textContent = "Next steps";
        const nextValue = document.createElement("span");
        nextValue.className = "value";
        nextValue.textContent = doc.globalJudgment.next_steps;
        nextRow.appendChild(nextLabel);
        nextRow.appendChild(nextValue);
        contentEl.appendChild(nextRow);
      }

      summaryCard.appendChild(headerEl);
      summaryCard.appendChild(contentEl);
      body.appendChild(summaryCard);
    }

    const list = document.createElement("div");
    list.className = "doc-highlight-list";
    doc.highlights.forEach((highlight) => {
      list.appendChild(createHighlightRow(doc, highlight));
    });
    body.appendChild(list);

    details.appendChild(body);
    return details;
  }

  function render() {
    containerEl.innerHTML = "";
    const docs = state.order
      .map((id) => state.docs.get(id))
      .filter(Boolean);
    docs.forEach((doc) => {
      sortHighlights(doc);
      containerEl.appendChild(renderDoc(doc));
    });
    renderProgress();
  }

  function upsertHighlight(entry, options = {}) {
    const doc = ensureDoc(entry);
    if (!doc) {
      return;
    }
    const { skipRender = false, markDirty = true } = options;
    const mapped = mapHighlight(entry, doc);
    const index = doc.highlights.findIndex((hl) => hl.id === mapped.id);
    if (index >= 0) {
      mapped.addedIndex = doc.highlights[index].addedIndex;
      doc.highlights[index] = { ...doc.highlights[index], ...mapped };
    } else {
      doc.highlights.push(mapped);
    }
    if (!skipRender) {
      render();
    }
  }

  function removeHighlights(predicate, options = {}) {
    state.docs.forEach((doc, id) => {
      const initialLength = doc.highlights.length;
      doc.highlights = doc.highlights.filter((highlight) => !predicate(highlight, doc));
      if (doc.highlights.length === 0) {
        state.docs.delete(id);
        state.order = state.order.filter((docId) => docId !== id);
      } else if (doc.highlights.length !== initialLength) {
        doc.reviewDirty = true;
      }
    });
    if (!options.skipRender) {
      render();
    }
  }

  window.__EA_HIGHLIGHT_SUMMARY__ = {
    add(entry) {
      upsertHighlight(entry);
    },
    remove(predicate) {
      removeHighlights(predicate);
    },
    reset(entries = []) {
      state.docs.clear();
      state.order = [];
      entries.forEach((entry) => {
        upsertHighlight(entry, { skipRender: true, markDirty: false });
      });
      render();
    },
    setEditHandler(handler) {
      editHandler = handler;
    },
    setReviewHandler(handler) {
      reviewHandler = handler;
    },
    updateDocumentSummary(documentId, summary) {
      const doc = state.docs.get(documentId);
      if (!doc) {
        return;
      }
      doc.globalJudgment = summary || null;
      render();
    },
    updateDocumentReview(documentId, review) {
      const doc = state.docs.get(documentId);
      if (!doc) {
        return;
      }
      if (review?.sentiment) {
        doc.sentiment = review.sentiment;
      }
      if (Array.isArray(review?.highlight_order)) {
        review.highlight_order.forEach((highlightId, index) => {
          const highlight = doc.highlights.find((hl) => hl.highlightId === highlightId);
          if (highlight) {
            highlight.rank = index + 1;
          }
        });
      }
      doc.reviewDirty = false;
      doc.savedReview = review;
      sortHighlights(doc);
      render();
    },
    getById(id) {
      for (const doc of state.docs.values()) {
        const found = doc.highlights.find((highlight) => highlight.id === id);
        if (found) {
          return { ...found, documentId: doc.id, title: doc.title, url: doc.url, type: doc.type };
        }
      }
      return null;
    },
  };
})();

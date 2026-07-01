const form = document.getElementById("lead-form");
const submitBtn = document.getElementById("submit-btn");
const btnLabel = submitBtn.querySelector(".btn-label");
const btnSpinner = submitBtn.querySelector(".btn-spinner");
const formNote = document.getElementById("form-note");
const successState = document.getElementById("success-state");
const resetBtn = document.getElementById("reset-btn");
const journeySteps = document.querySelectorAll("#journey li");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setStep(step) {
  journeySteps.forEach((li) => {
    li.classList.toggle("active", Number(li.dataset.step) <= step);
  });
}

function clearErrors() {
  document.querySelectorAll(".error").forEach((el) => (el.textContent = ""));
  formNote.textContent = "";
}

function showFieldError(name, message) {
  const el = document.querySelector(`.error[data-for="${name}"]`);
  if (el) el.textContent = message;
}

function validate(data) {
  const errors = {};
  if (!data.firstName.trim()) errors.firstName = "Required";
  if (!data.lastName.trim()) errors.lastName = "Required";
  if (!data.company.trim()) errors.company = "Required";
  if (!data.email.trim()) errors.email = "Required";
  else if (!EMAIL_RE.test(data.email.trim())) errors.email = "Enter a valid email";
  if (!data.budget) errors.budget = "Choose a range";
  return errors;
}

form.addEventListener("input", () => setStep(1));

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErrors();

  const data = Object.fromEntries(new FormData(form).entries());
  const errors = validate(data);

  if (Object.keys(errors).length) {
    Object.entries(errors).forEach(([field, msg]) => showFieldError(field, msg));
    formNote.textContent = "Please fix the highlighted fields.";
    return;
  }

  setStep(2);
  submitBtn.disabled = true;
  btnLabel.textContent = "Sending\u2026";
  btnSpinner.hidden = false;

  try {
    const res = await fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const payload = await res.json();

    if (!res.ok || !payload.ok) {
      const message = (payload.errors && payload.errors.join(" ")) || "Something went wrong. Please try again.";
      formNote.textContent = message;
      setStep(1);
      return;
    }

    setStep(3);
    form.hidden = true;
    successState.hidden = false;
  } catch (err) {
    formNote.textContent = "Couldn't reach the server. Please try again.";
    setStep(1);
  } finally {
    submitBtn.disabled = false;
    btnLabel.textContent = "Send it";
    btnSpinner.hidden = true;
  }
});

resetBtn.addEventListener("click", () => {
  form.reset();
  form.hidden = false;
  successState.hidden = true;
  clearErrors();
  setStep(1);
});

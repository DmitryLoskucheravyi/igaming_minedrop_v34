'use client';

/* ============================================================
   NUMFIELD — числове поле без <input type="number">.

   Нативний number малює власні стрілки-спінери: у темній темі вони
   білі, у кожному браузері свої, а пальцем у них однаково не влучиш.
   Вимикати їх правилами під -webkit- і -moz- доводилось окремо в
   кожному місці, і в мініапсі вони все одно проступали.

   Тут поле лишається текстовим, а цифрову клавіатуру дає inputMode.
   Нецифри вирізаються на вводі, тому вставлене «1 000 ₽» стає 1000,
   а не NaN, і батькові завжди приходить готове число.

   Дробову частину ВІДКИДАЄМО, а не склеюємо з цілою: просте вирізання
   нецифр перетворювало вставлене «12.50» на 1250 — сума мовчки росла
   в сто разів. Копійок у ставках і заявках немає, тому 12.50 -> 12.

   className є, бо тим самим полем користуються гра (глобальні класи
   globals.css) і CRM (свій css-модуль) — розмітка одна, класи різні.
   ============================================================ */

interface Props {
  id?: string;
  value: number;
  onChange: (n: number) => void;
  placeholder?: string;
  /** скільки цифр максимум — захист від випадкового «мільярда» */
  maxDigits?: number;
  className?: string;
  autoFocus?: boolean;
}

export function NumField({
  id, value, onChange, placeholder, maxDigits = 9, className = 'input big', autoFocus,
}: Props) {
  return (
    <input
      id={id}
      className={className}
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      autoFocus={autoFocus}
      /* 0 показуємо порожнім полем: інакше довелось би стирати нуль
         перед кожним введенням суми. */
      value={value ? String(value) : ''}
      placeholder={placeholder}
      onChange={(e) => {
        const whole = e.target.value.replace(',', '.').split('.')[0];
        const digits = whole.replace(/\D+/g, '').slice(0, maxDigits);
        onChange(digits ? Number(digits) : 0);
      }}
    />
  );
}

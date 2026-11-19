import './theme-review-checkbox.css';

export function ThemeReviewCheckbox({isChecked,onChange,isDisabled=false}:{isChecked:boolean;onChange:(isChecked:boolean)=>void;isDisabled?:boolean}) {
 return <label className="theme-review-option">
  <input type="checkbox" checked={isChecked} disabled={isDisabled} onChange={event=>onChange(event.currentTarget.checked)}/>
  라이트·다크 모드 함께 검사
 </label>;
}

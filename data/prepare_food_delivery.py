"""Prepare the Kaggle food delivery data for the delivery-time model."""

from pathlib import Path

import pandas as pd


PROJECT_DIR = Path(__file__).resolve().parents[1]
SOURCE_CSV = PROJECT_DIR / "data" / "raw" / "global_food_delivery_enriched_market_2026.csv"
OUTPUT_CSV = PROJECT_DIR / "data" / "food_delivery_2026.csv"

TARGET = "actual_delivery_time_min"

# The final 14 predictors agreed for the Online Delivery App subset.
FEATURES = [
    "metro_city",
    "cuisine_category",
    "order_value_usd",
    "discount_applied_usd",
    "delivery_distance_km",
    "estimated_prep_time_min",
    "delivery_fee_usd",
    "restaurant_price_tier",
    "is_peak_hour",
    "weather_condition",
    "discount_percentage",
    "delivery_fee_ratio",
    "customer_spending_tier",
    "estimated_restaurant_net_margin_usd",
]

# Every source field not retained in FEATURES + TARGET is documented here.
# - non-feature: identifier or free-form narrative, unsuitable as a model input
# - data leakage: target itself, derived from target, or only known after delivery
# - perfect collinearity: exactly derivable from other retained order-time fields
# - constant column: order_channel is constant after filtering to app orders
DROP_REASONS = {
    "order_id": "非特徵：訂單識別碼，無可泛化的預測意義。",
    "order_channel": "常數欄：篩選 Online Delivery App 後只有單一值。",
    "net_effective_order_price": (
        "完全共線：等於 order_value_usd - discount_applied_usd + delivery_fee_usd。"
    ),
    "delivery_speed_km_per_hr": "資料洩漏：由 delivery_distance_km 和目標外送時間推算。",
    "total_fulfillment_time_min": "資料洩漏：等於備餐時間加目標 actual_delivery_time_min。",
    "customer_rating": "資料洩漏：通常需訂單完成後才會知道。",
    "logistics_friction_index": "資料洩漏風險：指標定義不明，可能使用實際物流時間；保守排除。",
    "customer_satisfaction_tier": "資料洩漏：顧客滿意度需服務完成後才可評定。",
    "primary_satisfaction_driver": "資料洩漏：主要滿意度原因需服務完成後才可判定。",
    "cot_market_dynamics_rationale": "資料洩漏／非特徵：自由文字重述訂單與履約結果。",
    "confidence_score": "非特徵：計算依據與可用時點不明，無法確認為下單時可用資訊。",
}


def main() -> None:
    source = pd.read_csv(SOURCE_CSV)
    original_rows, original_columns = source.shape
    original_missing = int(source.isna().sum().sum())

    app_orders = source.loc[source["order_channel"] == "Online Delivery App"].copy()
    output = app_orders[FEATURES + [TARGET]].copy()
    output["is_peak_hour"] = output["is_peak_hour"].astype("int64")
    OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    output.to_csv(OUTPUT_CSV, index=False)

    output_rows, output_columns = output.shape
    output_missing = int(output.isna().sum().sum())

    print(f"原始資料：{original_rows} 筆、{original_columns} 欄、{original_missing} 個缺值")
    print(f"輸出資料：{output_rows} 筆、{output_columns} 欄（14 個特徵 + 1 個目標）、{output_missing} 個缺值")
    print(f"輸出檔案：{OUTPUT_CSV}")


if __name__ == "__main__":
    main()

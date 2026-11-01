"""Prepare complete country-year cases for the WHO life expectancy model."""

from pathlib import Path

import numpy as np
import pandas as pd


PROJECT_DIR = Path(__file__).resolve().parents[1]
SOURCE_CSV = PROJECT_DIR / "data" / "raw" / "Life Expectancy Data.csv"
OUTPUT_CSV = PROJECT_DIR / "data" / "life_expectancy.csv"

TARGET = "Life expectancy"

# Country is preserved only as the group-splitting key; it is not a predictor.
# BMI is excluded because its country-level values are implausible (median 43.5,
# 1,528 values > 40, and US/Japan/India medians 65.4/25.65/14.65).
# Population is excluded because it has 652 missing values, 412 values <100,000,
# and many abrupt multi-order-of-magnitude jumps between adjacent years.
FEATURES = [
    "Year",
    "Status",
    "Adult Mortality",
    "log1p_infant deaths",
    "Alcohol",
    "log1p_percentage expenditure",
    "Hepatitis B",
    "log1p_Measles",
    "log1p_under-five deaths",
    "Polio",
    "Total expenditure",
    "Diphtheria",
    "HIV/AIDS",
    "log1p_GDP",
    "thinness 1-19 years",
    "thinness 5-9 years",
    "Income composition of resources",
    "Schooling",
]

# These are the four non-feature columns omitted from the modeling output.
# Country remains in the file as a group key; target is retained as the label.
EXCLUDED_COLUMNS = {
    "BMI": "Excluded: values are implausible for country-average BMI.",
    "Population": "Excluded: suspiciously small and discontinuous country-year values, plus many missing values.",
}


def main() -> None:
    source = pd.read_csv(SOURCE_CSV)
    original_rows, original_columns = source.shape
    original_countries = int(source["Country"].nunique())
    original_missing = int(source.isna().sum().sum())

    # Strip leading/trailing whitespace and collapse repeated internal spaces;
    # the source has inconsistent names such as ' BMI ' and 'thinness  1-19'.
    source.columns = source.columns.str.strip().str.replace(r"\s+", " ", regex=True)

    # The two zero-heavy indices contain long country-year runs of zero that
    # are implausible as measured values; treat those sentinel-like zeros as NA.
    source["Income composition of resources"] = source[
        "Income composition of resources"
    ].replace(0, np.nan)
    source["Schooling"] = source["Schooling"].replace(0, np.nan)

    # Apply log1p to skewed nonnegative measures. Prefixes make the transform
    # visible to the browser and keep it consistent for both death-count fields.
    log_columns = {
        "infant deaths": "log1p_infant deaths",
        "percentage expenditure": "log1p_percentage expenditure",
        "Measles": "log1p_Measles",
        "under-five deaths": "log1p_under-five deaths",
        "GDP": "log1p_GDP",
    }
    for original_name in log_columns:
        if (source[original_name].dropna() < 0).any():
            raise ValueError(f"Cannot apply log1p to negative values in {original_name!r}")
        source[log_columns[original_name]] = np.log1p(source[original_name])

    # Keep complete cases for the target and every candidate predictor. The
    # browser performs the train/test split, so imputing here would leak test
    # statistics into preprocessing; dropping rows avoids that leakage.
    required_columns = ["Country", *FEATURES, TARGET]
    prepared = source.dropna(subset=required_columns)

    # Preserve Country only for country-grouped splitting, not as a model input;
    # the target is explicitly last for the existing CSV-driven web app.
    output = prepared[["Country", *FEATURES, TARGET]].copy()
    OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    output.to_csv(OUTPUT_CSV, index=False)

    output_rows, output_columns = output.shape
    output_countries = int(output["Country"].nunique())
    output_missing = int(output.isna().sum().sum())

    print(
        f"原始資料：{original_rows} 筆、{original_columns} 欄、"
        f"{original_countries} 個國家、{original_missing} 個缺值"
    )
    print(
        f"輸出資料：{output_rows} 筆、{output_columns} 欄（Country 分組欄 + "
        f"{len(FEATURES)} 個特徵 + 1 個目標）、{output_countries} 個國家、"
        f"{output_missing} 個缺值"
    )
    print(f"輸出檔案：{OUTPUT_CSV}")


if __name__ == "__main__":
    main()

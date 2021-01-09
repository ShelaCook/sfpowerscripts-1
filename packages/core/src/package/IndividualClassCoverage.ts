import SFPLogger from "../../lib/utils/SFPLogger";

export default class IndividualClassCoverage {
  public constructor(private codeCoverage: any) {}

  public getIndividualClassCoverage(): ClassCoverage[] {
    let individualClassCoverage: {
      name: string;
      coveredPercent: number;
    }[] = [];

    // Return every class in coverage json if test level is not RunAllTestsInPackage
    individualClassCoverage = this.codeCoverage.map((cls) => {
      return { name: cls.name, coveredPercent: cls.coveredPercent };
    });
    return individualClassCoverage;
  }

  public validateIndividualClassCoverage(
    individualClassCoverage: ClassCoverage[],
    coverageThreshold?: number
  ): {
    result: boolean;
    classesCovered?: ClassCoverage[];
    classesWithInvalidCoverage?: ClassCoverage[];
  } {
    if (coverageThreshold < 75) {
      SFPLogger.log("Setting minimum coverage percentage to 75%.");
      coverageThreshold = 75;
    }

    SFPLogger.log(
      `Validating individual classes for code coverage greater than ${coverageThreshold} percent`
    );
    let classesWithInvalidCoverage = individualClassCoverage.filter((cls) => {
      return cls.coveredPercent < coverageThreshold;
    });

    if (classesWithInvalidCoverage.length > 0) {
      return {
        result: false,
        classesCovered: individualClassCoverage,
        classesWithInvalidCoverage: classesWithInvalidCoverage,
      };
    } else return { result: true, classesCovered: individualClassCoverage };
  }
}

export type CoverageOptions = {
  isPackageCoverageToBeValidated: boolean;
  isIndividualClassCoverageToBeValidated: boolean;
  coverageThreshold: number;
};

export type ClassCoverage = {
  name: string;
  coveredPercent: number;
};

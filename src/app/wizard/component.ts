// Copyright 2021 The Kubermatic Kubernetes Platform contributors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {ChangeDetectionStrategy, Component, OnDestroy, OnInit, ViewChild} from '@angular/core';
import {FormBuilder, FormGroup} from '@angular/forms';
import {MatStepper} from '@angular/material/stepper';
import {Router} from '@angular/router';
import {GoogleAnalyticsService} from '@app/google-analytics.service';
import {ClusterService} from '@core/services/cluster';
import {ClusterSpecService} from '@core/services/cluster-spec';
import {NodeDataService} from '@core/services/node-data/service';
import {NotificationService} from '@core/services/notification';
import {ProjectService} from '@core/services/project';
import {WizardService} from '@core/services/wizard/wizard';
import {Cluster, CreateClusterModel} from '@shared/entity/cluster';
import {Project} from '@shared/entity/project';
import {SSHKey} from '@shared/entity/ssh-key';
import {NodeData} from '@shared/model/NodeSpecChange';
import {forkJoin, of, Subject, take} from 'rxjs';
import {filter, switchMap, takeUntil, tap} from 'rxjs/operators';
import {StepRegistry, steps, WizardStep} from './config';
import {MatDialog, MatDialogConfig} from '@angular/material/dialog';
import {SaveClusterTemplateDialogComponent} from '@shared/components/save-cluster-template/component';

@Component({
  selector: 'km-wizard',
  templateUrl: './template.html',
  styleUrls: ['./style.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WizardComponent implements OnInit, OnDestroy {
  form: FormGroup;
  project = {} as Project;
  creating = false;
  readonly stepRegistry = StepRegistry;

  @ViewChild('stepper', {static: true}) private readonly _stepper: MatStepper;

  private _unsubscribe: Subject<void> = new Subject<void>();

  constructor(
    private readonly _formBuilder: FormBuilder,
    private readonly _projectService: ProjectService,
    private readonly _wizard: WizardService,
    private readonly _notificationService: NotificationService,
    private readonly _clusterSpecService: ClusterSpecService,
    private readonly _clusterService: ClusterService,
    private readonly _nodeDataService: NodeDataService,
    private readonly _matDialog: MatDialog,
    private readonly _router: Router,
    private readonly _googleAnalyticsService: GoogleAnalyticsService
  ) {}

  get steps(): WizardStep[] {
    return this._wizard.steps.filter(step => step.enabled);
  }

  get active(): WizardStep {
    return this.steps[this._stepper.selectedIndex];
  }

  get first(): boolean {
    return this._stepper.selectedIndex === 0;
  }

  get last(): boolean {
    return this._stepper.selectedIndex === this.steps.length - 1;
  }

  get invalid(): boolean {
    return this.form.get(this.active.name).invalid;
  }

  ngOnInit(): void {
    this._wizard.reset();

    // Init steps for wizard
    this._wizard.steps = steps;
    this._wizard.stepper = this._stepper;

    this._initForm(this.steps);
    this._wizard.stepsChanges.pipe(takeUntil(this._unsubscribe)).subscribe(_ => this._initForm(this.steps));
    this._stepper.selectionChange.pipe(takeUntil(this._unsubscribe)).subscribe(selection => {
      if (selection.previouslySelectedIndex > selection.selectedIndex) {
        selection.previouslySelectedStep.reset();
      }
    });

    this._projectService.selectedProject
      .pipe(takeUntil(this._unsubscribe))
      .subscribe(project => (this.project = project));
  }

  ngOnDestroy(): void {
    this._unsubscribe.next();
    this._unsubscribe.complete();
    this._wizard.reset();
  }

  create(): void {
    this.creating = true;
    let createdCluster: Cluster;
    const createCluster = this._getCreateClusterModel(this._clusterSpecService.cluster, this._nodeDataService.nodeData);

    this._clusterService
      .create(this.project.id, createCluster)
      .pipe(
        tap(cluster => {
          this._notificationService.success(`Created the ${createCluster.cluster.name} cluster`);
          this._googleAnalyticsService.emitEvent('clusterCreation', 'clusterCreated');
          createdCluster = cluster;
        })
      )
      .pipe(switchMap(_ => this._clusterService.cluster(this.project.id, createdCluster.id)))
      .pipe(
        switchMap(_ => {
          this.creating = false;

          if (this._clusterSpecService.sshKeys.length > 0) {
            return forkJoin(
              this._clusterSpecService.sshKeys.map(key =>
                this._clusterService.createSSHKey(this.project.id, createdCluster.id, key.id)
              )
            );
          }

          return of([]);
        })
      )
      .pipe(takeUntil(this._unsubscribe))
      .subscribe({
        next: (keys: SSHKey[]) => {
          this._router.navigate([`/projects/${this.project.id}/clusters/${createdCluster.id}`]);
          keys.forEach(key =>
            this._notificationService.success(
              `Added the ${key.name} SSH key to the cluster ${createCluster.cluster.name}`
            )
          );
        },
        error: () => {
          this._notificationService.error(`Could not create the ${createCluster.cluster.name} cluster`);
          this._googleAnalyticsService.emitEvent('clusterCreation', 'clusterCreationFailed');
          this.creating = false;
        },
      });
  }

  private _getCreateClusterModel(cluster: Cluster, nodeData: NodeData): CreateClusterModel {
    return {
      cluster: {
        name: cluster.name,
        labels: cluster.labels,
        spec: cluster.spec,
        credential: cluster.credential,
      },
      nodeDeployment: {
        name: nodeData.name,
        spec: {
          template: nodeData.spec,
          replicas: nodeData.count,
          dynamicConfig: nodeData.dynamicConfig,
        },
      },
    };
  }

  private _initForm(steps: WizardStep[]): void {
    const controls = {};
    steps.forEach(step => (controls[step.name] = this._formBuilder.control('')));
    this.form = this._formBuilder.group(controls);
  }

  saveAsTemplate(): void {
    const dialogConfig: MatDialogConfig = {
      data: {
        cluster: this._clusterSpecService.cluster,
        nodeData: this._nodeDataService.nodeData,
        sshKeys: this._clusterSpecService.sshKeys,
        projectID: this.project.id,
      },
    };

    this._matDialog
      .open(SaveClusterTemplateDialogComponent, dialogConfig)
      .afterClosed()
      .pipe(filter(ct => !!ct))
      .pipe(take(1))
      .subscribe(ct => this._notificationService.success(`Saved the ${ct.name} cluster template`));
  }
}
